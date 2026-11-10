-- ============================================================
-- 520: Tables, phase 1: tables, rows, one write path and its undo log.
-- ============================================================
-- A table is a workspace's own database (src/lib/tables/): rows with a
-- title and the values of the table's own columns.
--
--   1. data_table: name, icon, description, an owner (a member), who may
--      read it (visibility 'workspace', or 'private' to its owner plus the
--      grants of 492), a `version` that every write batch bumps, a position
--      among the workspace's tables, archived_at.
--   2. data_row: a table's row: `title` (the primary column, what a mention
--      or a link shows), `custom_fields` (the values, keyed by column key,
--      exactly as 473 keeps a deal's), a position, archived_at.
--      Position is `numeric`, not a float or a text key: a new row goes after
--      the last (max + 1), and a row moved between two others takes their
--      midpoint as (a + b) * 0.5, which numeric computes exactly (a product
--      never rounds), so two rows never collide however often one moves. The
--      digits grow by about one per three moves into the same gap; a reorder
--      can renumber the table when that matters.
--   3. Columns are custom_field_definition rows (473, 496) with the new
--      `table_id`, entity_type 'data_row': one field system, so a column
--      takes the field types (and, from phase 2, the new ones) every kind
--      takes. A column's key is unique per (workspace, entity_type, table),
--      NULLS NOT DISTINCT so the workspace-wide fields keep their 473 rule.
--      A deleted column keeps its row (`deleted_at`) and its values stay on
--      the rows, so the undo of a delete is flat: clear deleted_at.
--   4. data_change: the undo log, one row per write batch: who (a member, or
--      the agent for a user), from where ('person', 'agent', 'import', …),
--      why, and `changes`, the batch's effects in order with each field's
--      before and after (src/lib/tables/types.ts DataChangeEntry). An undo
--      is a batch too: it names the change it takes back (undo_of) and marks
--      that one undone, in the same transaction.
--   5. Access. data_table_visible_to(table, user): a member of its workspace,
--      and the table is workspace-wide, or theirs, or a grant reaches them
--      (492). data_table_editable_by: the same without the grant arm (a grant
--      is view-only) and never a guest. Rows and changes follow their table.
--      The read policies compare against my_data_table_ids(), one array per
--      query (an InitPlan), so a page of rows costs one lookup, not one call
--      per row. visible_data_table_ids(ids, user) is the batched form for the
--      graph fences that run on the service role
--      (src/lib/knowledge/entity-fences.ts).
--   6. Writes. A member writes none of the three tables directly (SELECT
--      only); every write is one of two SECURITY DEFINER functions, which
--      check the caller's edit access themselves:
--        create_data_table(workspace, name, …, ops)   a new table, and its
--                                                     first columns and rows
--        apply_data_ops(table, base_version, ops, …)  one batch, all or nothing
--      apply_data_ops locks the table row, refuses a stale base_version with
--      SQLSTATE PT409 (PostgREST answers 409; the route says so), applies the
--      ops in order, bumps the version once, writes one data_change and
--      returns the new version and the ids it made. The ops and their checks
--      are in _data_apply below; the app validates every value against its
--      column first (src/lib/tables/ops.ts), and this checks the type again
--      where that is cheap.
--      A table column's definition is written only through these too: a
--      restrictive policy keeps a member's direct writes to the workspace's
--      own fields (table_id null), and another hides the columns of a table
--      they can't read.
--   7. Grants (492, 494, 495): entity_access takes 'data_table'. Its owner
--      may share it; the guard knows where a table lives; entity_grant_only
--      says when a table is seen only through a grant.
--   8. Realtime: data_table is published (REPLICA IDENTITY FULL). Every
--      batch bumps its version, so one event per batch tells a table's
--      viewers to read again; rows are not published (an import would be a
--      thousand events per viewer).
--   9. Workspace merge (402, 408, 473): the generic re-stamp carries the new
--      tables. _wsmerge_deals folded a source field into the destination's of
--      the same key; it now leaves table columns alone (their keys are per
--      table). _wsmerge_members now carries a table's owner, and a grant's
--      member and author (492), across a folded member: before, the folded
--      member's grants made the merge refuse (408's no-refs check).
--
-- The activity triggers for both kinds are 521. Re-runnable. No backslashes
-- anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. data_table
-- ------------------------------------------------------------

create table if not exists public.data_table (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  name text not null,
  icon text null,
  description text null,
  owner_member_id uuid null references public.member(id) on delete set null,
  created_by_user_id uuid null references auth.users(id) on delete set null,
  visibility text not null default 'workspace',
  version bigint not null default 0,
  position integer not null default 0,
  archived_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.data_table is
  'A workspace''s own table (520): rows in data_row, columns in custom_field_definition (table_id), every write batch in data_change.';
comment on column public.data_table.version is
  'Bumped once by every write batch (apply_data_ops). A write names the version it read; a stale one is refused (PT409).';

alter table public.data_table drop constraint if exists data_table_name_length;
alter table public.data_table
  add constraint data_table_name_length check (char_length(btrim(name)) between 1 and 200);
alter table public.data_table drop constraint if exists data_table_icon_length;
alter table public.data_table
  add constraint data_table_icon_length check (icon is null or char_length(icon) <= 32);
alter table public.data_table drop constraint if exists data_table_description_length;
alter table public.data_table
  add constraint data_table_description_length check (description is null or char_length(description) <= 2000);
alter table public.data_table drop constraint if exists data_table_visibility_check;
alter table public.data_table
  add constraint data_table_visibility_check check (visibility in ('workspace', 'private'));
alter table public.data_table drop constraint if exists data_table_version_nonneg;
alter table public.data_table
  add constraint data_table_version_nonneg check (version >= 0);

create index if not exists data_table_workspace_idx on public.data_table (workspace_id, position);
create index if not exists data_table_owner_idx on public.data_table (owner_member_id) where owner_member_id is not null;

-- ------------------------------------------------------------
-- 2. data_row
-- ------------------------------------------------------------

create table if not exists public.data_row (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  table_id uuid not null references public.data_table(id) on delete cascade,
  title text not null default '',
  custom_fields jsonb not null default '{}'::jsonb,
  position numeric not null,
  archived_at timestamptz null,
  created_by_user_id uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.data_row is
  'A table''s row (520): its title (the primary column) and its values in custom_fields, keyed by column key.';
comment on column public.data_row.position is
  'Order in the table. New rows go after the last (max + 1); a move takes its neighbours'' midpoint, (a + b) * 0.5, exact in numeric.';

alter table public.data_row drop constraint if exists data_row_title_length;
alter table public.data_row
  add constraint data_row_title_length check (char_length(title) <= 2000);
alter table public.data_row drop constraint if exists data_row_custom_fields_object;
alter table public.data_row
  add constraint data_row_custom_fields_object check (jsonb_typeof(custom_fields) = 'object');

create index if not exists data_row_table_position_idx on public.data_row (table_id, position) where archived_at is null;
create index if not exists data_row_table_archived_idx on public.data_row (table_id, archived_at) where archived_at is not null;
create index if not exists data_row_workspace_idx on public.data_row (workspace_id);

-- ------------------------------------------------------------
-- 3. Columns: custom_field_definition rows with a table
-- ------------------------------------------------------------

alter table public.custom_field_definition
  add column if not exists table_id uuid null references public.data_table(id) on delete cascade;
alter table public.custom_field_definition
  add column if not exists deleted_at timestamptz null;

comment on column public.custom_field_definition.table_id is
  'Set for a table''s column (entity_type data_row, 520); null for a workspace''s own field on a kind.';
comment on column public.custom_field_definition.deleted_at is
  'A deleted table column (520): kept, with its values on the rows, so an undo brings it back whole.';

alter table public.custom_field_definition drop constraint if exists custom_field_definition_entity_check;
alter table public.custom_field_definition
  add constraint custom_field_definition_entity_check
  check (entity_type in ('document', 'contact', 'project', 'action', 'initiative', 'company', 'deal', 'data_row'));

alter table public.custom_field_definition drop constraint if exists custom_field_definition_table_shape;
alter table public.custom_field_definition
  add constraint custom_field_definition_table_shape check ((entity_type = 'data_row') = (table_id is not null));

drop index if exists public.custom_field_definition_key;
create unique index custom_field_definition_key
  on public.custom_field_definition (workspace_id, entity_type, table_id, key) nulls not distinct;
create index if not exists custom_field_definition_table_idx
  on public.custom_field_definition (table_id, position) where table_id is not null;

-- ------------------------------------------------------------
-- 4. data_change: the undo log
-- ------------------------------------------------------------

create table if not exists public.data_change (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  table_id uuid not null references public.data_table(id) on delete cascade,
  version bigint not null,
  actor_user_id uuid null references auth.users(id) on delete set null,
  -- A plain id, not a foreign key: a departed member's history survives them.
  actor_member_id uuid null,
  source text not null default 'person',
  reason text null,
  changes jsonb not null default '[]'::jsonb,
  undo_of uuid null references public.data_change(id) on delete set null,
  undone_at timestamptz null,
  created_at timestamptz not null default now()
);

comment on table public.data_change is
  'One write batch to a table (520): changes = its effects in order, each field''s from and to. Undo writes the from values back.';

alter table public.data_change drop constraint if exists data_change_source_check;
alter table public.data_change
  add constraint data_change_source_check check (source in ('person', 'agent', 'import', 'email', 'capture', 'sms'));
alter table public.data_change drop constraint if exists data_change_reason_length;
alter table public.data_change
  add constraint data_change_reason_length check (reason is null or char_length(reason) <= 500);
alter table public.data_change drop constraint if exists data_change_changes_array;
alter table public.data_change
  add constraint data_change_changes_array check (jsonb_typeof(changes) = 'array');

create index if not exists data_change_table_idx on public.data_change (table_id, created_at desc);
create index if not exists data_change_undo_of_idx on public.data_change (undo_of) where undo_of is not null;

-- ------------------------------------------------------------
-- 5. Who may read and write a table
-- ------------------------------------------------------------
-- Each answers only for the caller themself, or for the service role (no
-- auth.uid()), which is who asks about others (495's rule for the twins).

create or replace function public.data_table_visible_to(p_table_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_user_id is not null
     and (auth.uid() is null or auth.uid() = p_user_id)
     and exists (
       select 1
         from public.data_table t
         join public.member m on m.workspace_id = t.workspace_id and m.user_id = p_user_id
        where t.id = p_table_id
          and (t.visibility = 'workspace'
               or (t.owner_member_id is not null and t.owner_member_id = m.id)
               or public.entity_grant_reaches('data_table', t.id, t.workspace_id, p_user_id))
     );
$$;

create or replace function public.data_table_editable_by(p_table_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_user_id is not null
     and (auth.uid() is null or auth.uid() = p_user_id)
     and exists (
       select 1
         from public.data_table t
         join public.member m on m.workspace_id = t.workspace_id and m.user_id = p_user_id
        where t.id = p_table_id
          and m.role <> 'guest'
          and (t.visibility = 'workspace'
               or (t.owner_member_id is not null and t.owner_member_id = m.id))
     );
$$;

-- Every table the caller may read, in every workspace they are in: the read
-- policies' one lookup per query. The grant arm is 493's: the array of ids a
-- grant may reach, then has_entity_grant's exact answer for those alone.
create or replace function public.my_data_table_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (
    select m.id, m.workspace_id from public.member m where m.user_id = auth.uid()
  ),
  granted as (
    select unnest(public.my_entity_grant_ids('data_table')) as id
  )
  select coalesce(array_agg(t.id), '{}'::uuid[])
    from public.data_table t
    join me on me.workspace_id = t.workspace_id
   where t.visibility = 'workspace'
      or t.owner_member_id = me.id
      or (t.id in (select id from granted) and public.has_entity_grant('data_table', t.id, t.workspace_id));
$$;

-- The ids among p_ids that p_user may read: the graph fences' batched form.
create or replace function public.visible_data_table_ids(p_ids uuid[], p_user_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(t.id), '{}'::uuid[])
    from public.data_table t
   where t.id = any (coalesce(p_ids, '{}'::uuid[]))
     and public.data_table_visible_to(t.id, p_user_id);
$$;

revoke all on function public.data_table_visible_to(uuid, uuid) from public, anon;
revoke all on function public.data_table_editable_by(uuid, uuid) from public, anon;
revoke all on function public.my_data_table_ids() from public, anon;
revoke all on function public.visible_data_table_ids(uuid[], uuid) from public, anon;
grant execute on function public.data_table_visible_to(uuid, uuid) to authenticated, service_role;
grant execute on function public.data_table_editable_by(uuid, uuid) to authenticated, service_role;
grant execute on function public.my_data_table_ids() to authenticated, service_role;
grant execute on function public.visible_data_table_ids(uuid[], uuid) to authenticated, service_role;

alter table public.data_table enable row level security;
alter table public.data_row enable row level security;
alter table public.data_change enable row level security;

drop policy if exists data_table_select on public.data_table;
create policy data_table_select on public.data_table
  for select to authenticated
  using (id = any ((select public.my_data_table_ids())::uuid[]));

drop policy if exists data_row_select on public.data_row;
create policy data_row_select on public.data_row
  for select to authenticated
  using (table_id = any ((select public.my_data_table_ids())::uuid[]));

drop policy if exists data_change_select on public.data_change;
create policy data_change_select on public.data_change
  for select to authenticated
  using (table_id = any ((select public.my_data_table_ids())::uuid[]));

revoke all on table public.data_table, public.data_row, public.data_change from anon, authenticated;
grant select on table public.data_table, public.data_row, public.data_change to authenticated;
grant all on table public.data_table, public.data_row, public.data_change to service_role;

-- A table's columns: read with the table, written only through the functions
-- below. Restrictive, so 473's member policy still decides the rest.
drop policy if exists custom_field_definition_table_read on public.custom_field_definition;
create policy custom_field_definition_table_read on public.custom_field_definition
  as restrictive for select to authenticated
  using (table_id is null or table_id = any ((select public.my_data_table_ids())::uuid[]));

drop policy if exists custom_field_definition_table_insert on public.custom_field_definition;
create policy custom_field_definition_table_insert on public.custom_field_definition
  as restrictive for insert to authenticated
  with check (table_id is null);

drop policy if exists custom_field_definition_table_update on public.custom_field_definition;
create policy custom_field_definition_table_update on public.custom_field_definition
  as restrictive for update to authenticated
  using (table_id is null)
  with check (table_id is null);

drop policy if exists custom_field_definition_table_delete on public.custom_field_definition;
create policy custom_field_definition_table_delete on public.custom_field_definition
  as restrictive for delete to authenticated
  using (table_id is null);

-- ------------------------------------------------------------
-- 6. The write path
-- ------------------------------------------------------------

-- Does a value fit its column? The app checks the same, more kindly
-- (src/lib/crm/custom-fields.ts coerceCustomValue); this is the floor.
create or replace function public._data_value_ok(p_type text, p_options text[], p_value jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(case p_type
    when 'text' then jsonb_typeof(p_value) = 'string' and char_length(p_value #>> '{}') <= 2000
    when 'number' then jsonb_typeof(p_value) = 'number'
    when 'date' then jsonb_typeof(p_value) = 'string' and (p_value #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    when 'select' then jsonb_typeof(p_value) = 'string' and (p_value #>> '{}') = any (p_options)
    else false
  end, false);
$$;

revoke all on function public._data_value_ok(text, text[], jsonb) from public, anon, authenticated;

-- A row's values with a patch merged in: a JSON null removes the key. Every
-- key must be a live column of the table and every value must fit it.
create or replace function public._data_merge_values(p_table public.data_table, p_current jsonb, p_patch jsonb)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  k text;
  v jsonb;
  col record;
  out jsonb := coalesce(p_current, '{}'::jsonb);
begin
  if p_patch is null then
    return out;
  end if;
  if jsonb_typeof(p_patch) <> 'object' then
    raise exception 'values must be an object' using errcode = '22023';
  end if;
  for k, v in select * from jsonb_each(p_patch) loop
    select d.field_type, d.options into col
      from public.custom_field_definition d
     where d.workspace_id = p_table.workspace_id
       and d.entity_type = 'data_row'
       and d.table_id = p_table.id
       and d.key = k
       and d.deleted_at is null;
    if not found then
      raise exception 'no column %', k using errcode = '22023';
    end if;
    if jsonb_typeof(v) = 'null' then
      out := out - k;
    elsif not public._data_value_ok(col.field_type, col.options, v) then
      raise exception 'that value does not fit column %', k using errcode = '22023';
    else
      out := out || jsonb_build_object(k, v);
    end if;
  end loop;
  return out;
end;
$$;

revoke all on function public._data_merge_values(public.data_table, jsonb, jsonb) from public, anon, authenticated;

-- Applies a batch of ops to one table, in order, and returns what each did:
--   {changes: [...], inserted_row_ids: [...], created_column_ids: {key: id}}
-- An op that changes nothing adds no change. The caller holds the table's row
-- lock and has checked edit access; p_member is the caller's member row.
--
-- The ops (src/lib/tables/types.ts DataOp):
--   update_table     {name?, icon?, description?, visibility?}  (visibility: the owner only)
--   archive_table    {}            restore_table  {}
--   create_column    {key, label, field_type, options?}
--   update_column    {key, label?, options?}  (an option still in use can't go)
--   delete_column    {key}         restore_column {key}
--   reorder_columns  {keys: [...]} (the live columns, in their new order)
--   insert_rows      {rows: [{id?, title?, values?}]}  (after the last row)
--   update_row       {row_id, title?, values?}  (values merge; null clears)
--   archive_rows     {row_ids}     restore_rows   {row_ids}
--   move_row         {row_id, after_row_id?} or {row_id, position}
create or replace function public._data_apply(p_table_id uuid, p_user uuid, p_member uuid, p_ops jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t public.data_table%rowtype;
  op jsonb;
  kind text;
  changes jsonb := '[]'::jsonb;
  inserted jsonb := '[]'::jsonb;
  created_cols jsonb := '{}'::jsonb;
  fields jsonb;
  col public.custom_field_definition%rowtype;
  r public.data_row%rowtype;
  v_key text;
  v_label text;
  v_options text[];
  v_type text;
  v_title text;
  v_values jsonb;
  v_ids uuid[];
  v_done uuid[];
  v_keys text[];
  v_before text[];
  v_after text[];
  v_new jsonb;
  v_elem jsonb;
  v_pos numeric;
  v_next numeric;
  v_n int;
  v_id uuid;
begin
  if p_ops is null or jsonb_typeof(p_ops) <> 'array' then
    raise exception 'ops must be a list' using errcode = '22023';
  end if;
  if jsonb_array_length(p_ops) > 500 then
    raise exception 'at most 500 ops in one batch' using errcode = '22023';
  end if;

  for op in select value from jsonb_array_elements(p_ops) loop
    select * into t from public.data_table where id = p_table_id;
    kind := op ->> 'op';

    if kind = 'update_table' then
      fields := '{}'::jsonb;
      if op ? 'name' and (op ->> 'name') is distinct from t.name then
        fields := fields || jsonb_build_object('name', jsonb_build_object('from', t.name, 'to', op ->> 'name'));
      end if;
      if op ? 'icon' and (op ->> 'icon') is distinct from t.icon then
        fields := fields || jsonb_build_object('icon', jsonb_build_object('from', t.icon, 'to', op ->> 'icon'));
      end if;
      if op ? 'description' and (op ->> 'description') is distinct from t.description then
        fields := fields || jsonb_build_object('description', jsonb_build_object('from', t.description, 'to', op ->> 'description'));
      end if;
      if op ? 'visibility' and (op ->> 'visibility') is distinct from t.visibility then
        if t.owner_member_id is distinct from p_member then
          raise exception 'only the table''s owner can change who sees it' using errcode = '42501';
        end if;
        fields := fields || jsonb_build_object('visibility', jsonb_build_object('from', t.visibility, 'to', op ->> 'visibility'));
      end if;
      if fields <> '{}'::jsonb then
        update public.data_table
           set name = case when fields ? 'name' then op ->> 'name' else name end,
               icon = case when fields ? 'icon' then op ->> 'icon' else icon end,
               description = case when fields ? 'description' then op ->> 'description' else description end,
               visibility = case when fields ? 'visibility' then op ->> 'visibility' else visibility end,
               updated_at = now()
         where id = t.id;
        changes := changes || jsonb_build_array(jsonb_build_object('op', kind, 'fields', fields));
      end if;

    elsif kind in ('archive_table', 'restore_table') then
      if (kind = 'archive_table') = (t.archived_at is null) then
        update public.data_table
           set archived_at = case when kind = 'archive_table' then now() end, updated_at = now()
         where id = t.id;
        changes := changes || jsonb_build_array(jsonb_build_object('op', kind));
      end if;

    elsif kind = 'create_column' then
      v_key := op ->> 'key';
      v_label := btrim(coalesce(op ->> 'label', ''));
      v_type := op ->> 'field_type';
      v_options := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(op -> 'options', '[]'::jsonb)) x), '{}');
      if exists (select 1 from public.custom_field_definition d
                  where d.workspace_id = t.workspace_id and d.entity_type = 'data_row' and d.table_id = t.id and d.key = v_key) then
        raise exception 'a column with key % already exists', v_key using errcode = '22023';
      end if;
      insert into public.custom_field_definition (workspace_id, entity_type, table_id, key, label, field_type, options, position)
      values (t.workspace_id, 'data_row', t.id, v_key, v_label, v_type,
              case when v_type = 'select' then v_options else '{}' end,
              coalesce((select max(d.position) + 1 from public.custom_field_definition d where d.table_id = t.id), 0))
      returning * into col;
      created_cols := created_cols || jsonb_build_object(col.key, col.id);
      changes := changes || jsonb_build_array(jsonb_build_object(
        'op', kind, 'key', col.key, 'column_id', col.id, 'label', col.label, 'field_type', col.field_type, 'options', to_jsonb(col.options)));

    elsif kind in ('update_column', 'delete_column', 'restore_column') then
      v_key := op ->> 'key';
      select * into col from public.custom_field_definition d
       where d.workspace_id = t.workspace_id and d.entity_type = 'data_row' and d.table_id = t.id and d.key = v_key;
      if not found then
        raise exception 'no column %', v_key using errcode = '22023';
      end if;
      if kind = 'update_column' then
        if col.deleted_at is not null then
          raise exception 'column % is deleted', v_key using errcode = '22023';
        end if;
        fields := '{}'::jsonb;
        if op ? 'label' and btrim(op ->> 'label') is distinct from col.label then
          fields := fields || jsonb_build_object('label', jsonb_build_object('from', col.label, 'to', btrim(op ->> 'label')));
        end if;
        if op ? 'options' and col.field_type = 'select' then
          v_options := coalesce((select array_agg(x) from jsonb_array_elements_text(op -> 'options') x), '{}');
          if v_options is distinct from col.options then
            select count(*) into v_n from public.data_row dr
             where dr.table_id = t.id and dr.custom_fields ? v_key and not ((dr.custom_fields ->> v_key) = any (v_options));
            if v_n > 0 then
              raise exception '% still % an option that would go', case when v_n = 1 then '1 row' else v_n || ' rows' end,
                case when v_n = 1 then 'has' else 'have' end using errcode = '22023';
            end if;
            fields := fields || jsonb_build_object('options', jsonb_build_object('from', to_jsonb(col.options), 'to', to_jsonb(v_options)));
          end if;
        end if;
        if fields <> '{}'::jsonb then
          update public.custom_field_definition
             set label = case when fields ? 'label' then btrim(op ->> 'label') else label end,
                 options = case when fields ? 'options' then v_options else options end
           where id = col.id;
          changes := changes || jsonb_build_array(jsonb_build_object('op', kind, 'key', v_key, 'fields', fields));
        end if;
      elsif (kind = 'delete_column') = (col.deleted_at is null) then
        update public.custom_field_definition
           set deleted_at = case when kind = 'delete_column' then now() end
         where id = col.id;
        changes := changes || jsonb_build_array(jsonb_build_object('op', kind, 'key', v_key));
      end if;

    elsif kind = 'reorder_columns' then
      v_keys := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(op -> 'keys', '[]'::jsonb)) x), '{}');
      select coalesce(array_agg(d.key order by d.position, d.created_at), '{}') into v_before
        from public.custom_field_definition d
       where d.table_id = t.id and d.deleted_at is null;
      if cardinality(v_keys) <> (select count(distinct x) from unnest(v_keys) x)
         or not (v_keys <@ v_before) then
        raise exception 'reorder_columns names a column twice, or one that is not there' using errcode = '22023';
      end if;
      -- The ones not named keep their order, after the named ones.
      v_after := v_keys || coalesce((select array_agg(x order by i) from unnest(v_before) with ordinality u(x, i) where not (x = any (v_keys))), '{}');
      if v_after is distinct from v_before then
        update public.custom_field_definition d
           set position = u.i - 1
          from unnest(v_after) with ordinality u(x, i)
         where d.table_id = t.id and d.key = u.x;
        changes := changes || jsonb_build_array(jsonb_build_object('op', kind, 'from', to_jsonb(v_before), 'to', to_jsonb(v_after)));
      end if;

    elsif kind = 'insert_rows' then
      if jsonb_typeof(op -> 'rows') <> 'array' or jsonb_array_length(op -> 'rows') > 1000 then
        raise exception 'insert_rows takes a list of at most 1000 rows' using errcode = '22023';
      end if;
      select coalesce(max(dr.position), 0) into v_pos from public.data_row dr where dr.table_id = t.id;
      v_new := '[]'::jsonb;
      for v_elem in select value from jsonb_array_elements(op -> 'rows') loop
        v_pos := floor(v_pos) + 1;
        v_id := coalesce(nullif(v_elem ->> 'id', '')::uuid, gen_random_uuid());
        v_title := coalesce(v_elem ->> 'title', '');
        v_values := public._data_merge_values(t, '{}'::jsonb, v_elem -> 'values');
        v_new := v_new || jsonb_build_array(jsonb_build_object('id', v_id, 'title', v_title, 'values', v_values, 'position', v_pos));
      end loop;
      -- One statement, so the activity log's statement trigger runs once (521).
      insert into public.data_row (id, workspace_id, table_id, title, custom_fields, position, created_by_user_id)
      select (e ->> 'id')::uuid, t.workspace_id, t.id, e ->> 'title', e -> 'values', (e ->> 'position')::numeric, p_user
        from jsonb_array_elements(v_new) e;
      if jsonb_array_length(v_new) > 0 then
        select jsonb_agg(e -> 'id') into v_elem from jsonb_array_elements(v_new) e;
        inserted := inserted || v_elem;
        changes := changes || jsonb_build_array(jsonb_build_object('op', kind, 'row_ids', v_elem));
      end if;

    elsif kind = 'update_row' then
      select * into r from public.data_row dr where dr.id = (op ->> 'row_id')::uuid and dr.table_id = t.id for update;
      if not found then
        raise exception 'no row %', op ->> 'row_id' using errcode = '22023';
      end if;
      v_title := case when op ? 'title' then coalesce(op ->> 'title', '') else r.title end;
      v_values := public._data_merge_values(t, r.custom_fields, op -> 'values');
      fields := '{}'::jsonb;
      if v_title is distinct from r.title then
        fields := fields || jsonb_build_object('title', jsonb_build_object('from', r.title, 'to', v_title));
      end if;
      select fields || coalesce(jsonb_object_agg('values.' || k, jsonb_build_object('from', r.custom_fields -> k, 'to', v_values -> k)), '{}'::jsonb)
        into fields
        from (select jsonb_object_keys(r.custom_fields) as k union select jsonb_object_keys(v_values)) u
       where (r.custom_fields -> u.k) is distinct from (v_values -> u.k);
      if fields <> '{}'::jsonb then
        update public.data_row set title = v_title, custom_fields = v_values, updated_at = now() where id = r.id;
        changes := changes || jsonb_build_array(jsonb_build_object('op', kind, 'row_id', r.id, 'fields', fields));
      end if;

    elsif kind in ('archive_rows', 'restore_rows') then
      v_ids := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(op -> 'row_ids', '[]'::jsonb)) x), '{}');
      if cardinality(v_ids) > 1000 then
        raise exception '% takes at most 1000 rows', kind using errcode = '22023';
      end if;
      with done as (
        update public.data_row dr
           set archived_at = case when kind = 'archive_rows' then now() end, updated_at = now()
         where dr.table_id = t.id
           and dr.id = any (v_ids)
           and (dr.archived_at is null) = (kind = 'archive_rows')
        returning dr.id
      )
      select coalesce(array_agg(id), '{}') into v_done from done;
      if cardinality(v_done) > 0 then
        changes := changes || jsonb_build_array(jsonb_build_object('op', kind, 'row_ids', to_jsonb(v_done)));
      end if;

    elsif kind = 'move_row' then
      select * into r from public.data_row dr where dr.id = (op ->> 'row_id')::uuid and dr.table_id = t.id for update;
      if not found then
        raise exception 'no row %', op ->> 'row_id' using errcode = '22023';
      end if;
      if op ? 'position' then
        v_pos := (op ->> 'position')::numeric;
      elsif nullif(op ->> 'after_row_id', '') is null then
        -- To the top: before the first row.
        select min(dr.position) into v_next from public.data_row dr where dr.table_id = t.id and dr.id <> r.id;
        v_pos := coalesce(v_next - 1, r.position);
      else
        select dr.position into v_pos from public.data_row dr where dr.id = (op ->> 'after_row_id')::uuid and dr.table_id = t.id;
        if v_pos is null then
          raise exception 'no row %', op ->> 'after_row_id' using errcode = '22023';
        end if;
        select min(dr.position) into v_next from public.data_row dr where dr.table_id = t.id and dr.position > v_pos and dr.id <> r.id;
        v_pos := case when v_next is null then floor(v_pos) + 1 else (v_pos + v_next) * 0.5 end;
      end if;
      if v_pos is distinct from r.position then
        update public.data_row set position = v_pos, updated_at = now() where id = r.id;
        changes := changes || jsonb_build_array(jsonb_build_object('op', kind, 'row_id', r.id, 'from', r.position::text, 'to', v_pos::text));
      end if;

    else
      raise exception 'unknown op %', coalesce(kind, '(none)') using errcode = '22023';
    end if;
  end loop;

  return jsonb_build_object('changes', changes, 'inserted_row_ids', inserted, 'created_column_ids', created_cols);
end;
$$;

revoke all on function public._data_apply(uuid, uuid, uuid, jsonb) from public, anon, authenticated;

-- Who is writing: the signed-in caller, or (the service role only) the user
-- a server tool acts for. p_as_user is ignored for a signed-in caller.
create or replace function public._data_writer(p_as_user uuid)
returns uuid
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(auth.uid(), case when auth.uid() is null then p_as_user end);
$$;

revoke all on function public._data_writer(uuid) from public, anon, authenticated;

create or replace function public.apply_data_ops(
  p_table_id uuid,
  p_base_version bigint,
  p_ops jsonb,
  p_source text default 'person',
  p_reason text default null,
  p_undo_of uuid default null,
  p_as_user uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := public._data_writer(p_as_user);
  t public.data_table%rowtype;
  v_member uuid;
  v_result jsonb;
  v_undone public.data_change%rowtype;
  v_version bigint;
  v_change uuid;
begin
  if v_user is null then
    raise exception 'apply_data_ops: no user' using errcode = '42501';
  end if;
  -- The lock serializes batches on one table: the version check below is exact.
  select * into t from public.data_table where id = p_table_id for update;
  if not found or not public.data_table_visible_to(t.id, v_user) then
    raise exception 'table not found' using errcode = 'P0002';
  end if;
  if not public.data_table_editable_by(t.id, v_user) then
    raise exception 'you can view this table but not change it' using errcode = '42501';
  end if;
  if p_base_version is not null and p_base_version <> t.version then
    raise exception 'the table changed since version %', p_base_version
      using errcode = 'PT409', detail = t.version::text;
  end if;
  if coalesce(p_source, '') not in ('person', 'agent', 'import', 'email', 'capture', 'sms') then
    raise exception 'unknown source %', p_source using errcode = '22023';
  end if;
  select m.id into v_member from public.member m where m.user_id = v_user and m.workspace_id = t.workspace_id;

  if p_undo_of is not null then
    select * into v_undone from public.data_change c where c.id = p_undo_of and c.table_id = t.id for update;
    if not found then
      raise exception 'change not found' using errcode = '22023';
    end if;
    if v_undone.undo_of is not null then
      raise exception 'that change was itself an undo' using errcode = '22023';
    end if;
    if v_undone.undone_at is not null then
      raise exception 'that change was already undone' using errcode = '22023';
    end if;
  end if;

  -- The activity log reads the source (521: an import logs no row creations),
  -- and this batch makes no new table.
  perform set_config('dial8.data_source', p_source, true);
  perform set_config('dial8.data_new_table', '', true);
  v_result := public._data_apply(t.id, v_user, v_member, p_ops);

  if jsonb_array_length(v_result -> 'changes') = 0 then
    return jsonb_build_object('version', t.version, 'change_id', null, 'inserted_row_ids', '[]'::jsonb, 'created_column_ids', '{}'::jsonb);
  end if;

  update public.data_table set version = version + 1, updated_at = now() where id = t.id returning version into v_version;
  insert into public.data_change (workspace_id, table_id, version, actor_user_id, actor_member_id, source, reason, changes, undo_of)
  values (t.workspace_id, t.id, v_version, v_user, v_member, p_source, nullif(btrim(coalesce(p_reason, '')), ''), v_result -> 'changes', p_undo_of)
  returning id into v_change;
  if p_undo_of is not null then
    update public.data_change set undone_at = now() where id = p_undo_of;
  end if;

  return jsonb_build_object(
    'version', v_version,
    'change_id', v_change,
    'inserted_row_ids', v_result -> 'inserted_row_ids',
    'created_column_ids', v_result -> 'created_column_ids'
  );
end;
$$;

revoke all on function public.apply_data_ops(uuid, bigint, jsonb, text, text, uuid, uuid) from public, anon;
grant execute on function public.apply_data_ops(uuid, bigint, jsonb, text, text, uuid, uuid) to authenticated, service_role;

-- A new table, and (p_ops) its first columns and rows, in one transaction:
-- version 1, one change that starts with {op: 'create_table'}. Any member but
-- a guest; the creator owns it.
create or replace function public.create_data_table(
  p_workspace_id uuid,
  p_name text,
  p_visibility text default 'workspace',
  p_icon text default null,
  p_description text default null,
  p_ops jsonb default '[]'::jsonb,
  p_source text default 'person',
  p_as_user uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := public._data_writer(p_as_user);
  v_member uuid;
  v_role text;
  v_table uuid;
  v_result jsonb;
  v_change uuid;
begin
  if v_user is null then
    raise exception 'create_data_table: no user' using errcode = '42501';
  end if;
  select m.id, m.role into v_member, v_role from public.member m where m.user_id = v_user and m.workspace_id = p_workspace_id;
  if v_member is null then
    raise exception 'workspace not found' using errcode = 'P0002';
  end if;
  if v_role = 'guest' then
    raise exception 'a guest can''t make tables' using errcode = '42501';
  end if;
  if coalesce(p_source, '') not in ('person', 'agent', 'import', 'email', 'capture', 'sms') then
    raise exception 'unknown source %', p_source using errcode = '22023';
  end if;

  insert into public.data_table (workspace_id, name, icon, description, visibility, owner_member_id, created_by_user_id, version, position)
  values (p_workspace_id, btrim(coalesce(p_name, '')), p_icon, p_description, coalesce(p_visibility, 'workspace'), v_member, v_user, 1,
          coalesce((select max(d.position) + 1 from public.data_table d where d.workspace_id = p_workspace_id), 0))
  returning id into v_table;

  perform set_config('dial8.data_source', p_source, true);
  -- Its first rows are part of making it: the activity log says the table was
  -- made, not each blank row (521).
  perform set_config('dial8.data_new_table', v_table::text, true);
  v_result := public._data_apply(v_table, v_user, v_member, coalesce(p_ops, '[]'::jsonb));

  insert into public.data_change (workspace_id, table_id, version, actor_user_id, actor_member_id, source, changes)
  values (p_workspace_id, v_table, 1, v_user, v_member, p_source,
          jsonb_build_array(jsonb_build_object('op', 'create_table')) || (v_result -> 'changes'))
  returning id into v_change;

  return jsonb_build_object(
    'table_id', v_table,
    'version', 1,
    'change_id', v_change,
    'inserted_row_ids', v_result -> 'inserted_row_ids',
    'created_column_ids', v_result -> 'created_column_ids'
  );
end;
$$;

revoke all on function public.create_data_table(uuid, text, text, text, text, jsonb, text, uuid) from public, anon;
grant execute on function public.create_data_table(uuid, text, text, text, text, jsonb, text, uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 7. Grants on a table (492, 495)
-- ------------------------------------------------------------

alter table public.entity_access drop constraint if exists entity_access_entity_type;
alter table public.entity_access
  add constraint entity_access_entity_type check (entity_type in ('document', 'capture', 'contact', 'company', 'data_table'));

-- 495's guard, with the table arm.
create or replace function public.entity_access_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- A workspace merge (402) re-stamps every workspace_id by catalogue, table
  -- by table, as the service role; the grantee's and the record's own tables
  -- may not have moved yet. The merge asserts the whole destination itself.
  if auth.uid() is null and coalesce(current_setting('dial8.workspace_merge', true), '') <> '' then
    return new;
  end if;
  -- A signed-in caller: the insert policy's question first, with one answer
  -- for every refusal, so nothing below tells them what exists.
  if auth.uid() is not null and not coalesce(
       public.is_workspace_member(new.workspace_id)
       and public.entity_access_can_share(new.entity_type, new.entity_id, new.workspace_id)
       and (new.grantee_kind <> 'team' or exists (
             select 1 from public.team t
              where t.id = new.grantee_team_id and t.workspace_id = new.workspace_id
                and (not t.is_private or public.is_team_member(t.id))))
       and (new.grantee_kind <> 'channel' or public.team_chat_can_read(new.grantee_channel_id)),
     false) then
    raise exception 'entity_access: not allowed' using errcode = '42501';
  end if;
  if new.grantee_kind = 'member' and not exists (
    select 1 from public.member m where m.id = new.grantee_member_id and m.workspace_id = new.workspace_id
  ) then
    raise exception 'entity_access: the member is not in this workspace' using errcode = '23514';
  end if;
  if new.grantee_kind = 'team' and not exists (
    select 1 from public.team t where t.id = new.grantee_team_id and t.workspace_id = new.workspace_id
  ) then
    raise exception 'entity_access: the team is not in this workspace' using errcode = '23514';
  end if;
  if new.grantee_kind = 'channel' and not exists (
    select 1 from public.team_chat_channel c where c.id = new.grantee_channel_id and c.workspace_id = new.workspace_id
  ) then
    raise exception 'entity_access: the channel is not in this workspace' using errcode = '23514';
  end if;
  if not (case new.entity_type
    when 'document' then exists (select 1 from public.document x where x.id = new.entity_id and x.workspace_id = new.workspace_id)
    when 'capture' then exists (select 1 from public.captures x where x.id = new.entity_id and x.workspace_id = new.workspace_id)
    when 'contact' then exists (select 1 from public.contact x where x.id = new.entity_id and x.workspace_id = new.workspace_id)
    when 'company' then exists (select 1 from public.company x where x.id = new.entity_id and x.workspace_id = new.workspace_id)
    when 'data_table' then exists (select 1 from public.data_table x where x.id = new.entity_id and x.workspace_id = new.workspace_id)
    else false
  end) then
    raise exception 'entity_access: the record is not in this workspace' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.entity_access_guard() from public, anon, authenticated;

-- 494's entity_grant_only, with the table arm: seen only through a grant.
create or replace function public.entity_grant_only(p_type text, p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and p_id is not null and coalesce(case p_type
    when 'document' then exists (
      select 1 from public.document d
       where d.id = p_id
         and not coalesce(public.is_workspace_member(d.workspace_id)
               and (d.visibility = 'workspace' or d.created_by = public.current_member_id(d.workspace_id)), false)
         and public.has_entity_grant('document', d.id, d.workspace_id))
    when 'capture' then exists (
      select 1 from public.captures c
       where c.id = p_id
         and not coalesce(public.is_workspace_member(c.workspace_id)
               and (c.visibility = 'workspace' or c.user_id = auth.uid()), false)
         and public.has_entity_grant('capture', c.id, c.workspace_id))
    when 'contact' then exists (
      select 1 from public.contact ct
       where ct.id = p_id
         and not coalesce(public.can_view_contact(ct.id, ct.workspace_id, ct.visibility, ct.created_by_member_id), false)
         and public.has_entity_grant('contact', ct.id, ct.workspace_id))
    when 'company' then exists (
      select 1 from public.company co
       where co.id = p_id
         and not coalesce(public.is_workspace_member(co.workspace_id)
               and (public.get_member_role(co.workspace_id) in ('owner', 'admin')
                    or exists (
                      select 1 from public.contact ct
                       where ct.company_id = co.id
                         and public.can_view_contact(ct.id, ct.workspace_id, ct.visibility, ct.created_by_member_id))), false)
         and (public.has_entity_grant('company', co.id, co.workspace_id)
              or exists (
                select 1 from public.contact ct
                 where ct.company_id = co.id
                   and public.has_entity_grant('contact', ct.id, ct.workspace_id))))
    when 'data_table' then exists (
      select 1 from public.data_table dt
       where dt.id = p_id
         and not coalesce(public.is_workspace_member(dt.workspace_id)
               and (dt.visibility = 'workspace' or dt.owner_member_id = public.current_member_id(dt.workspace_id)), false)
         and public.has_entity_grant('data_table', dt.id, dt.workspace_id))
    else false
  end, false);
$$;

revoke all on function public.entity_grant_only(text, uuid) from public, anon;
grant execute on function public.entity_grant_only(text, uuid) to authenticated, service_role;

-- 492's rule, with the table arm: a table's owner shares it.
create or replace function public.entity_access_can_share(p_type text, p_id uuid, p_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
    and public.is_workspace_member(p_workspace)
    and case p_type
      when 'document' then exists (
        select 1 from public.document d
         where d.id = p_id and d.workspace_id = p_workspace
           and d.created_by is not null
           and d.created_by = public.current_member_id(p_workspace))
      when 'capture' then exists (
        select 1 from public.captures c
         where c.id = p_id and c.workspace_id = p_workspace
           and c.user_id = auth.uid()
           and not c.is_eval)
      when 'contact' then exists (
        select 1 from public.contact ct
         where ct.id = p_id and ct.workspace_id = p_workspace
           and ((ct.created_by_member_id is not null and ct.created_by_member_id = public.current_member_id(p_workspace))
                or public.get_member_role(p_workspace) in ('owner', 'admin')))
      when 'company' then exists (
        select 1 from public.company co
         where co.id = p_id and co.workspace_id = p_workspace
           and public.get_member_role(p_workspace) in ('owner', 'admin'))
      when 'data_table' then exists (
        select 1 from public.data_table dt
         where dt.id = p_id and dt.workspace_id = p_workspace
           and dt.owner_member_id is not null
           and dt.owner_member_id = public.current_member_id(p_workspace))
      else false
    end;
$$;

revoke all on function public.entity_access_can_share(text, uuid, uuid) from public, anon;
grant execute on function public.entity_access_can_share(text, uuid, uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 8. Realtime: one event per batch, on the table's row
-- ------------------------------------------------------------

alter table public.data_table replica identity full;
do $$ begin
  alter publication supabase_realtime add table public.data_table;
exception when duplicate_object then null;
end $$;

-- ------------------------------------------------------------
-- 9. Workspace merge
-- ------------------------------------------------------------
-- 473's _wsmerge_deals, with one change: a source field folds into the
-- destination's of the same key only when neither is a table's column.

CREATE OR REPLACE FUNCTION public._wsmerge_deals(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  p record;
  s record;
  v_dst_pipeline uuid;
  v_dst_stage uuid;
  v_pos int;
  n_deals int := 0;
  n_fields int := 0;
BEGIN
  DROP TABLE IF EXISTS pg_temp._wsmerge_deal_stages;
  CREATE TEMP TABLE _wsmerge_deal_stages (src uuid PRIMARY KEY, dst uuid NOT NULL, dst_pipeline uuid NOT NULL) ON COMMIT DROP;

  FOR p IN SELECT * FROM public.deal_pipeline WHERE workspace_id = p_source ORDER BY is_default DESC, position LOOP
    SELECT d.id INTO v_dst_pipeline FROM public.deal_pipeline d
      WHERE d.workspace_id = p_dest AND ((p.is_default AND d.is_default) OR lower(d.name) = lower(p.name))
      ORDER BY (p.is_default AND d.is_default) DESC, d.position
      LIMIT 1;
    IF v_dst_pipeline IS NULL THEN
      -- No counterpart: the pipeline moves whole, and stays the default only
      -- where the destination has none.
      UPDATE public.deal_pipeline
         SET workspace_id = p_dest,
             is_default = p.is_default AND NOT EXISTS (SELECT 1 FROM public.deal_pipeline d WHERE d.workspace_id = p_dest AND d.is_default)
       WHERE id = p.id;
      UPDATE public.deal_stage SET workspace_id = p_dest WHERE pipeline_id = p.id;
      INSERT INTO pg_temp._wsmerge_deal_stages SELECT id, id, p.id FROM public.deal_stage WHERE pipeline_id = p.id;
    ELSE
      FOR s IN SELECT * FROM public.deal_stage WHERE pipeline_id = p.id ORDER BY position LOOP
        SELECT d.id INTO v_dst_stage FROM public.deal_stage d
          WHERE d.pipeline_id = v_dst_pipeline AND lower(d.name) = lower(s.name)
          LIMIT 1;
        IF v_dst_stage IS NULL THEN
          SELECT coalesce(max(position), -1) + 1 INTO v_pos FROM public.deal_stage WHERE pipeline_id = v_dst_pipeline;
          UPDATE public.deal_stage SET workspace_id = p_dest, pipeline_id = v_dst_pipeline, position = v_pos WHERE id = s.id;
          v_dst_stage := s.id;
        END IF;
        INSERT INTO pg_temp._wsmerge_deal_stages VALUES (s.id, v_dst_stage, v_dst_pipeline);
      END LOOP;
    END IF;
  END LOOP;

  -- Contacts the merge folded into the destination's (_wsmerge_contacts):
  -- the deal follows them to the surviving contact.
  IF to_regclass('pg_temp._wsmerge_contacts') IS NOT NULL THEN
    UPDATE public.deal d
       SET contact_ids = (SELECT array_agg(DISTINCT coalesce(m.dst, c)) FROM unnest(d.contact_ids) c
                            LEFT JOIN pg_temp._wsmerge_contacts m ON m.src = c)
     WHERE d.workspace_id = p_source
       AND d.contact_ids && (SELECT coalesce(array_agg(src), '{}') FROM pg_temp._wsmerge_contacts);
  END IF;

  UPDATE public.deal d
     SET workspace_id = p_dest, stage_id = m.dst, pipeline_id = m.dst_pipeline
    FROM pg_temp._wsmerge_deal_stages m
   WHERE d.workspace_id = p_source AND d.stage_id = m.src;
  GET DIAGNOSTICS n_deals = ROW_COUNT;
  -- What is left in the source (folded pipelines and their emptied stages) goes.
  DELETE FROM public.deal_pipeline WHERE workspace_id = p_source;

  -- A table's columns are its own (keys are per table): they move with the
  -- generic re-stamp, never fold.
  DELETE FROM public.custom_field_definition f
   WHERE f.workspace_id = p_source
     AND f.table_id IS NULL
     AND EXISTS (SELECT 1 FROM public.custom_field_definition d
                  WHERE d.workspace_id = p_dest AND d.entity_type = f.entity_type AND d.key = f.key AND d.table_id IS NULL);
  GET DIAGNOSTICS n_fields = ROW_COUNT;

  RETURN jsonb_build_object('deals_moved', n_deals, 'custom_fields_folded', n_fields);
END;
$$;

REVOKE EXECUTE ON FUNCTION public._wsmerge_deals(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- 408's _wsmerge_members, with three more plain pointers: a table's owner,
-- and a grant's member and author (492). Every other line is 408's.
CREATE OR REPLACE FUNCTION public._wsmerge_members(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_folded int := 0; v_moved int := 0; v_invites_moved int := 0; v_invites_dropped int := 0;
BEGIN
  UPDATE public.member d
  SET role = CASE WHEN d.role = 'owner' THEN 'owner'
                  WHEN s.role = 'owner' THEN 'admin'
                  WHEN public._wsmerge_role_rank(s.role) > public._wsmerge_role_rank(d.role) THEN s.role
                  ELSE d.role END,
      avatar_url = COALESCE(d.avatar_url, s.avatar_url),
      time_zone = COALESCE(d.time_zone, s.time_zone),
      onboarding_completed_at = COALESCE(d.onboarding_completed_at, s.onboarding_completed_at)
  FROM pg_temp._wsmerge_members x
  JOIN public.member s ON s.id = x.src
  WHERE d.id = x.dst;

  -- plain pointers
  UPDATE public.actions t SET assignee_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.assignee_id = x.src;
  UPDATE public.campaign t SET owner_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.owner_member_id = x.src;
  UPDATE public.capture_participant t SET member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.member_id = x.src;
  UPDATE public.claim t SET created_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.created_by = x.src;
  UPDATE public.claim t SET subject_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.subject_member_id = x.src;
  UPDATE public.comment t SET author_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.author_id = x.src;
  UPDATE public.contact t SET created_by_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.created_by_member_id = x.src;
  UPDATE public.contact t SET member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.member_id = x.src;
  IF to_regclass('public.deal') IS NOT NULL THEN
    EXECUTE 'UPDATE public.deal t SET owner_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.owner_id = x.src';
  END IF;
  UPDATE public.decision t SET decided_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.decided_by = x.src;
  UPDATE public.document t SET created_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.created_by = x.src;
  UPDATE public.document t SET last_edited_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.last_edited_by = x.src;
  UPDATE public.document_revision t SET author_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.author_id = x.src;
  UPDATE public.document_section_check t SET verified_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.verified_by = x.src;
  UPDATE public.entity_link t SET created_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.created_by = x.src;
  UPDATE public.initiative t SET owner_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.owner_id = x.src;
  UPDATE public.invite t SET invited_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.invited_by = x.src;
  UPDATE public.lens_finding t SET member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.member_id = x.src;
  UPDATE public.notification t SET actor_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.actor_id = x.src;
  UPDATE public.notification t SET recipient_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.recipient_id = x.src;
  UPDATE public.projects t SET lead_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.lead_id = x.src;
  UPDATE public.proposed_change t SET applied_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.applied_by = x.src;
  UPDATE public.proposed_change t SET assignee_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.assignee_member_id = x.src;
  UPDATE public.share t SET created_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.created_by = x.src;
  UPDATE public.tool_approval t SET member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.member_id = x.src;
  UPDATE public.tracked_job t SET member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.member_id = x.src;
  UPDATE public.attention_item t SET member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.member_id = x.src;
  UPDATE public.contact_share t SET shared_by_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.shared_by_member_id = x.src;
  IF to_regclass('public.slack_user_link') IS NOT NULL THEN
    EXECUTE 'UPDATE public.slack_user_link t SET member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.member_id = x.src';
  END IF;
  -- Tables (520) and grants (492): one person's member row in each
  -- workspace, so a grant or an ownership never needs a duplicate dropped.
  UPDATE public.data_table t SET owner_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.owner_member_id = x.src;
  UPDATE public.entity_access t SET grantee_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.grantee_member_id = x.src;
  UPDATE public.entity_access t SET granted_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.granted_by = x.src;

  -- junctions unique on the member: translate where free, drop the duplicate
  UPDATE public.team_member t SET member_id = x.dst FROM pg_temp._wsmerge_members x
  WHERE t.member_id = x.src AND NOT EXISTS (SELECT 1 FROM public.team_member y WHERE y.team_id = t.team_id AND y.member_id = x.dst);
  DELETE FROM public.team_member t USING pg_temp._wsmerge_members x WHERE t.member_id = x.src;

  UPDATE public.action_assignee t SET member_id = x.dst FROM pg_temp._wsmerge_members x
  WHERE t.member_id = x.src AND NOT EXISTS (SELECT 1 FROM public.action_assignee y WHERE y.action_id = t.action_id AND y.member_id = x.dst);
  DELETE FROM public.action_assignee t USING pg_temp._wsmerge_members x WHERE t.member_id = x.src;

  UPDATE public.contact_share t SET shared_with_member_id = x.dst FROM pg_temp._wsmerge_members x
  WHERE t.shared_with_member_id = x.src AND NOT EXISTS (SELECT 1 FROM public.contact_share y WHERE y.contact_id = t.contact_id AND y.shared_with_member_id = x.dst);
  DELETE FROM public.contact_share t USING pg_temp._wsmerge_members x WHERE t.shared_with_member_id = x.src;

  UPDATE public.knowledge_package_share t SET shared_with_member_id = x.dst FROM pg_temp._wsmerge_members x
  WHERE t.shared_with_member_id = x.src AND NOT EXISTS (SELECT 1 FROM public.knowledge_package_share y WHERE y.package_id = t.package_id AND y.shared_with_member_id = x.dst);
  DELETE FROM public.knowledge_package_share t USING pg_temp._wsmerge_members x WHERE t.shared_with_member_id = x.src;

  UPDATE public.document_draft t SET author_id = x.dst FROM pg_temp._wsmerge_members x
  WHERE t.author_id = x.src AND NOT EXISTS (SELECT 1 FROM public.document_draft y WHERE y.document_id = t.document_id AND y.author_id = x.dst);
  DELETE FROM public.document_draft t USING pg_temp._wsmerge_members x WHERE t.author_id = x.src;

  -- nothing may still point at a folded row (408)
  PERFORM public._wsmerge_assert_no_refs('member', (SELECT array_agg(src) FROM pg_temp._wsmerge_members), '{}');

  -- the folded rows go: nothing of theirs is left for the departure triggers
  DELETE FROM public.member m USING pg_temp._wsmerge_members x WHERE m.id = x.src;
  GET DIAGNOSTICS v_folded = ROW_COUNT;

  UPDATE public.member
  SET workspace_id = p_dest, role = CASE WHEN role = 'owner' THEN 'admin' ELSE role END
  WHERE workspace_id = p_source;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  DELETE FROM public.invite i
  WHERE i.workspace_id = p_source AND (
    i.accepted_at IS NOT NULL OR i.expires_at <= now()
    OR EXISTS (SELECT 1 FROM public.member dm JOIN auth.users u ON u.id = dm.user_id
               WHERE dm.workspace_id = p_dest AND lower(u.email) = lower(i.email))
    OR EXISTS (SELECT 1 FROM public.invite di WHERE di.workspace_id = p_dest AND di.accepted_at IS NULL
               AND di.expires_at > now() AND lower(di.email) = lower(i.email)));
  GET DIAGNOSTICS v_invites_dropped = ROW_COUNT;
  UPDATE public.invite SET workspace_id = p_dest WHERE workspace_id = p_source;
  GET DIAGNOSTICS v_invites_moved = ROW_COUNT;

  RETURN jsonb_build_object('members_folded', v_folded, 'members_moved', v_moved,
                            'invites_moved', v_invites_moved, 'invites_dropped', v_invites_dropped);
END;
$$;

REVOKE EXECUTE ON FUNCTION public._wsmerge_members(uuid, uuid) FROM PUBLIC, anon, authenticated;
