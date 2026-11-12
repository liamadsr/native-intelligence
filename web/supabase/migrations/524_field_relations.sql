-- ============================================================
-- 524: a relation value is an edge (Tables, phase 2).
-- ============================================================
-- A relation field (523) holds record ids in a record's custom_fields. Each
-- id is mirrored into entity_link, from the record (a table's row, a
-- contact, a deal, …) to the record it links, relation 'field_link', so the
-- link shows in the target's "Referenced in" and History like any other
-- edge, and the graph reads it.
--
--   1. custom_field_links_sync(kind, workspace, id, table, old, new, writer,
--      resync): the one helper. A person a write sets must be a member of
--      the workspace. A linked id with no edge yet is checked: it must exist
--      in the workspace, be of the field's target kind (a table's rows: that
--      table's), not be the record itself, and be readable by the writer
--      (entity_visible_to, without grants when dial8.data_grants is 'off':
--      a guest's or a linked agent's turn) when the writer is known. One
--      refusal for every reason, so nothing says what exists. An id that
--      already has its edge passed when it came (a teammate may have linked
--      a document this writer can't see); an id with none never did, however
--      it got into the value, so it is checked whatever the write changed.
--      Then the record's field_link edges are made to match the live
--      relation fields' ids: one edge per target however many fields hold
--      it, an edge whose last value went is deleted.
--      The writer is the signed-in caller, or the user a table write names
--      (_data_apply sets dial8.data_writer, 525); a service-role write to a
--      kind names no one, and the app checked its ids for the person first
--      (src/lib/crm/custom-field-references.ts).
--   2. A trigger on every table that holds custom fields (the seven kinds of
--      496, and data_row) runs it after an insert with values, and after an
--      update that changes them.
--   3. A field's definition changing its type, its target or whether it is
--      deleted (a table's column), or going, re-syncs the edges of the
--      records that hold its key, with no checks. Only the type changes
--      (525's change_column_type, 526's change_custom_field_type) may change
--      a definition's type or config: a member's direct update of either is
--      refused (custom_field_definition_guard), so a multi-select holding a
--      private document's id can't be flipped to a relation and linked
--      unchecked, and a new person or relation field can't take a key that
--      records still hold values under.
--   4. Every write of a kind's values is held to the floor (523's
--      _field_value_ok) for the keys it changes, under the record's row
--      lock: a write that read a field's type just before a type change
--      converted it is refused ("read it again"), never stored as the old
--      type. A table's rows have 525's floor in their write path.
--   5. The clean-up when a linked record is deleted: a statement trigger on
--      each target kind's table deletes the field_link edges to the deleted
--      rows and takes their ids out of the values that held them (a list left
--      empty goes), in the same transaction, so a value never points at
--      nothing. Edges FROM a deleted record go too. A row's values changing
--      this way bumps its table's version, so its viewers read again; the
--      tables are locked first, in id order, as apply_data_ops locks a table
--      before its rows, so the two never wait on each other in a circle.
--      Archiving changes nothing: the link is still there when it comes
--      back. A workspace being deleted skips it. A workspace merge (402)
--      skips it too: the merge folds members, contacts and companies into
--      the destination's, and 528 rewrites the person and relation values
--      and the edges that named a folded record to the record it folded
--      into.
--
-- After 523. Idempotent (create or replace, drop trigger if exists). No
-- backslashes anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- The table a custom-field kind's values live on (src/lib/knowledge/entity-registry.ts).
create or replace function public._custom_field_table(p_kind text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_kind
    when 'contact' then 'contact'
    when 'company' then 'company'
    when 'deal' then 'deal'
    when 'action' then 'actions'
    when 'project' then 'projects'
    when 'initiative' then 'initiative'
    when 'document' then 'document'
    when 'data_row' then 'data_row'
  end;
$$;

-- Is p_id a record of p_kind in the workspace (a table's row: of p_table)?
create or replace function public._relation_target_ok(p_kind text, p_id uuid, p_workspace uuid, p_table uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(case p_kind
    when 'contact' then exists (select 1 from public.contact x where x.id = p_id and x.workspace_id = p_workspace)
    when 'company' then exists (select 1 from public.company x where x.id = p_id and x.workspace_id = p_workspace)
    when 'deal' then exists (select 1 from public.deal x where x.id = p_id and x.workspace_id = p_workspace)
    when 'action' then exists (select 1 from public.actions x where x.id = p_id and x.workspace_id = p_workspace)
    when 'project' then exists (select 1 from public.projects x where x.id = p_id and x.workspace_id = p_workspace)
    when 'initiative' then exists (select 1 from public.initiative x where x.id = p_id and x.workspace_id = p_workspace)
    when 'document' then exists (select 1 from public.document x where x.id = p_id and x.workspace_id = p_workspace)
    when 'capture' then exists (select 1 from public.captures x where x.id = p_id and x.workspace_id = p_workspace)
    when 'flow' then exists (select 1 from public.flow x where x.id = p_id and x.workspace_id = p_workspace)
    when 'data_row' then exists (select 1 from public.data_row x where x.id = p_id and x.workspace_id = p_workspace and x.table_id = p_table)
    else false
  end, false);
$$;

-- ── 1. The one helper ───────────────────────────────────────────────────────
create or replace function public.custom_field_links_sync(
  p_kind text,
  p_workspace uuid,
  p_id uuid,
  p_table uuid,
  p_old jsonb,
  p_new jsonb,
  p_writer uuid,
  p_resync boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d record;
  v_id text;
  v_any boolean := false;
  v_target text;
  v_target_table uuid;
begin
  for d in
    select f.key, f.label, f.field_type, f.config
      from public.custom_field_definition f
     where f.workspace_id = p_workspace
       and f.entity_type = p_kind
       and ((p_table is null and f.table_id is null) or f.table_id = p_table)
       and f.deleted_at is null
       and f.field_type in ('person', 'relation')
  loop
    v_any := true;
    if p_resync then
      continue;
    end if;
    if d.field_type = 'person' then
      if (p_new -> d.key) is not distinct from (p_old -> d.key) then
        continue;
      end if;
      if jsonb_typeof(p_new -> d.key) = 'string' and not exists (
           select 1 from public.member m where m.id::text = (p_new ->> d.key) and m.workspace_id = p_workspace) then
        raise exception '% takes a member of this workspace', d.label using errcode = '22023';
      end if;
      continue;
    end if;
    v_target := d.config -> 'target' ->> 'kind';
    v_target_table := nullif(d.config -> 'target' ->> 'table_id', '')::uuid;
    -- Every id without its edge yet: what it links was never checked.
    for v_id in
      select x from jsonb_array_elements_text(case when jsonb_typeof(p_new -> d.key) = 'array' then p_new -> d.key else '[]'::jsonb end) x
    loop
      if v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception '% links a record that isn''t one you can link to', d.label using errcode = '22023';
      end if;
      if exists (select 1 from public.entity_link l
                  where l.workspace_id = p_workspace and l.source_type = p_kind and l.source_id = p_id
                    and l.relation = 'field_link' and l.target_type = v_target and l.target_id = v_id::uuid) then
        continue;
      end if;
      if (v_target = p_kind and v_id::uuid = p_id)
         or not public._relation_target_ok(v_target, v_id::uuid, p_workspace, v_target_table)
         or (p_writer is not null and not public.entity_visible_to(v_target, v_id::uuid, p_workspace, p_writer,
               coalesce(current_setting('dial8.data_grants', true), '') <> 'off')) then
        raise exception '% links a record that isn''t one you can link to', d.label using errcode = '22023';
      end if;
    end loop;
  end loop;
  -- No person or relation field here: nothing to check, and no edge to keep
  -- (a field that went re-syncs its records itself, below).
  if not v_any and not p_resync then
    return;
  end if;

  with want as (
    select distinct f.config -> 'target' ->> 'kind' as target_type, x::uuid as target_id
      from public.custom_field_definition f
      cross join lateral jsonb_array_elements_text(case when jsonb_typeof(p_new -> f.key) = 'array' then p_new -> f.key else '[]'::jsonb end) x
     where f.workspace_id = p_workspace
       and f.entity_type = p_kind
       and ((p_table is null and f.table_id is null) or f.table_id = p_table)
       and f.deleted_at is null
       and f.field_type = 'relation'
       and x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  gone as (
    delete from public.entity_link l
     where l.workspace_id = p_workspace
       and l.source_type = p_kind
       and l.source_id = p_id
       and l.relation = 'field_link'
       and not exists (select 1 from want w where w.target_type = l.target_type and w.target_id = l.target_id)
  )
  insert into public.entity_link (workspace_id, source_type, source_id, target_type, target_id, relation, created_by)
  select p_workspace, p_kind, p_id, w.target_type, w.target_id, 'field_link',
         (select m.id from public.member m where m.user_id = p_writer and m.workspace_id = p_workspace)
    from want w
   where not (w.target_type = p_kind and w.target_id = p_id)
  on conflict (workspace_id, source_type, source_id, target_type, target_id, relation) do nothing;
end;
$$;

revoke all on function public._custom_field_table(text) from public, anon, authenticated;
revoke all on function public._relation_target_ok(text, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.custom_field_links_sync(text, uuid, uuid, uuid, jsonb, jsonb, uuid, boolean) from public, anon, authenticated;

-- ── 2. Every write of a record's values ─────────────────────────────────────
create or replace function public.custom_field_links_on_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- A workspace merge (402) re-stamps edges and values itself.
  if coalesce(current_setting('dial8.workspace_merge', true), '') <> '' then
    return null;
  end if;
  perform public.custom_field_links_sync(
    tg_argv[0],
    new.workspace_id,
    new.id,
    case when tg_argv[0] = 'data_row' then (to_jsonb(new) ->> 'table_id')::uuid end,
    case when tg_op = 'UPDATE' then old.custom_fields else '{}'::jsonb end,
    new.custom_fields,
    coalesce(auth.uid(), nullif(current_setting('dial8.data_writer', true), '')::uuid),
    false);
  return null;
end;
$$;

revoke all on function public.custom_field_links_on_write() from public, anon, authenticated;

do $$
declare
  k record;
begin
  for k in select * from (values
    ('contact', 'contact'), ('company', 'company'), ('deal', 'deal'), ('action', 'actions'),
    ('project', 'projects'), ('initiative', 'initiative'), ('document', 'document'), ('data_row', 'data_row')
  ) v(kind, tbl) loop
    execute format('drop trigger if exists custom_field_links_insert on public.%I', k.tbl);
    execute format(
      'create trigger custom_field_links_insert after insert on public.%I for each row '
      || 'when (new.custom_fields <> ''{}''::jsonb) execute function public.custom_field_links_on_write(%L)', k.tbl, k.kind);
    execute format('drop trigger if exists custom_field_links_update on public.%I', k.tbl);
    execute format(
      'create trigger custom_field_links_update after update of custom_fields on public.%I for each row '
      || 'when (old.custom_fields is distinct from new.custom_fields) execute function public.custom_field_links_on_write(%L)', k.tbl, k.kind);
  end loop;
end $$;

-- ── 3. A relation field changing or going ───────────────────────────────────
create or replace function public.custom_field_links_definition()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_tbl text := public._custom_field_table(old.entity_type);
begin
  if coalesce(current_setting('dial8.workspace_merge', true), '') <> '' then return null; end if;
  if tg_op = 'DELETE' and old.field_type <> 'relation' then return null; end if;
  if tg_op = 'UPDATE' and (
       (old.field_type <> 'relation' and new.field_type <> 'relation')
       or (old.field_type = new.field_type
           and old.deleted_at is not distinct from new.deleted_at
           and (old.config -> 'target') is not distinct from (new.config -> 'target'))) then
    return null;
  end if;
  -- A workspace being deleted takes everything with it.
  if v_tbl is null or not exists (select 1 from public.workspace w where w.id = old.workspace_id) then return null; end if;
  for r in execute format(
    'select id, custom_fields from public.%I where workspace_id = $1 and custom_fields ? $2'
    || case when old.table_id is not null then ' and table_id = $3' else '' end, v_tbl)
    using old.workspace_id, old.key, old.table_id
  loop
    perform public.custom_field_links_sync(old.entity_type, old.workspace_id, r.id, old.table_id, r.custom_fields, r.custom_fields, null, true);
  end loop;
  return null;
end;
$$;

revoke all on function public.custom_field_links_definition() from public, anon, authenticated;

drop trigger if exists custom_field_links_definition on public.custom_field_definition;
create trigger custom_field_links_definition
  after update of field_type, config, deleted_at or delete on public.custom_field_definition
  for each row execute function public.custom_field_links_definition();

-- ── 3b. Only a type change changes a definition's type or config ────────────
-- 525's _data_apply and 526's _custom_field_retype set
-- dial8.field_definition_write for their own transaction; a workspace merge
-- is its own (dial8.workspace_merge).
create or replace function public.custom_field_definition_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tbl text;
  v_held boolean;
begin
  if coalesce(current_setting('dial8.workspace_merge', true), '') <> ''
     or coalesce(current_setting('dial8.field_definition_write', true), '') = 'on' then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.field_type is distinct from old.field_type or new.config is distinct from old.config then
      raise exception 'a field changes type or settings through its type change' using errcode = '42501';
    end if;
    return new;
  end if;
  -- A new person or relation field on a kind: no record may already hold a
  -- value under its key (a field deleted and made again would link it unchecked).
  if new.table_id is null and new.field_type in ('person', 'relation') then
    v_tbl := public._custom_field_table(new.entity_type);
    if v_tbl is not null then
      execute format('select exists (select 1 from public.%I where workspace_id = $1 and custom_fields ? $2)', v_tbl)
        into v_held using new.workspace_id, new.key;
      if v_held then
        raise exception 'records still hold values under %: name the field differently', new.key using errcode = '22023';
      end if;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.custom_field_definition_guard() from public, anon, authenticated;

drop trigger if exists custom_field_definition_guard on public.custom_field_definition;
create trigger custom_field_definition_guard
  before insert or update of field_type, config on public.custom_field_definition
  for each row execute function public.custom_field_definition_guard();

-- ── 4. A kind's values fit their fields ─────────────────────────────────────
create or replace function public.custom_field_values_fit()
returns trigger
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  d record;
begin
  if coalesce(current_setting('dial8.workspace_merge', true), '') <> '' then
    return new;
  end if;
  -- The fields this write holds values of, share-locked: a type change locks
  -- its field for update, so the two take turns, and this reads the type
  -- the change left (a type change waits for this write the other way round,
  -- then converts what it wrote).
  for d in
    select f.key, f.label, f.field_type, f.options, f.config
      from public.custom_field_definition f
     where f.workspace_id = new.workspace_id
       and f.entity_type = tg_argv[0]
       and f.table_id is null
       and new.custom_fields ? f.key
       for share of f
  loop
    if tg_op = 'UPDATE' and (new.custom_fields -> d.key) is not distinct from (old.custom_fields -> d.key) then
      continue;
    end if;
    if jsonb_typeof(new.custom_fields -> d.key) <> 'null'
       and not public._field_value_ok(d.field_type, d.options, d.config, new.custom_fields -> d.key) then
      raise exception '% doesn''t take that value (it may have just changed type): read it again and retry', d.label using errcode = '22023';
    end if;
  end loop;
  return new;
end;
$$;

revoke all on function public.custom_field_values_fit() from public, anon, authenticated;

do $$
declare
  k record;
begin
  for k in select * from (values
    ('contact', 'contact'), ('company', 'company'), ('deal', 'deal'), ('action', 'actions'),
    ('project', 'projects'), ('initiative', 'initiative'), ('document', 'document')
  ) v(kind, tbl) loop
    execute format('drop trigger if exists custom_field_values_fit on public.%I', k.tbl);
    execute format(
      'create trigger custom_field_values_fit before insert or update of custom_fields on public.%I for each row '
      || 'when (new.custom_fields <> ''{}''::jsonb) execute function public.custom_field_values_fit(%L)', k.tbl, k.kind);
  end loop;
end $$;

-- ── 5. A linked record deleted ──────────────────────────────────────────────

-- Values with the ids taken out of the given keys' lists (a list left empty goes).
create or replace function public._custom_fields_without(p_values jsonb, p_keys text[], p_ids uuid[])
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_object_agg(s.k, s.v), '{}'::jsonb)
    from (
      select e.key as k,
             case when e.key = any (p_keys) and jsonb_typeof(e.value) = 'array'
                  then (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements(e.value) x
                         where not (lower(x #>> '{}') = any (p_ids::text[])))
                  else e.value end as v
        from jsonb_each(coalesce(p_values, '{}'::jsonb)) e
    ) s
   where s.v <> '[]'::jsonb;
$$;

revoke all on function public._custom_fields_without(jsonb, text[], uuid[]) from public, anon, authenticated;

create or replace function public.custom_field_links_forget()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind text := tg_argv[0];
  v_gone jsonb;
  s record;
  v_tbl text;
  v_table uuid;
  v_keys text[];
begin
  if coalesce(current_setting('dial8.workspace_merge', true), '') <> '' then return null; end if;

  -- The tables whose rows this will change, locked first and in id order:
  -- apply_data_ops locks a table, then its rows (520).
  perform 1
     from public.data_table dt
    where dt.id in (
      select r.table_id
        from public.entity_link l
        join old_rows o on o.workspace_id = l.workspace_id and o.id = l.target_id
        join public.data_row r on r.id = l.source_id
       where l.target_type = v_kind and l.relation = 'field_link' and l.source_type = 'data_row')
    order by dt.id
      for update of dt;

  -- Edges FROM a deleted record: nothing holds them any more.
  delete from public.entity_link l
   using old_rows o
   where l.workspace_id = o.workspace_id and l.source_type = v_kind and l.source_id = o.id and l.relation = 'field_link';

  -- Edges TO one: gone, and the ids out of the values that held them.
  with gone as (
    delete from public.entity_link l
     using old_rows o
     where l.workspace_id = o.workspace_id and l.target_type = v_kind and l.target_id = o.id and l.relation = 'field_link'
    returning l.workspace_id, l.source_type, l.source_id, l.target_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('workspace_id', g.workspace_id, 'source_type', g.source_type, 'source_id', g.source_id, 'ids', g.ids)), '[]'::jsonb)
    into v_gone
    from (
      select gone.workspace_id, gone.source_type, gone.source_id, array_agg(gone.target_id) as ids
        from gone
        join public.workspace w on w.id = gone.workspace_id
       group by 1, 2, 3
    ) g;

  for s in select * from jsonb_to_recordset(v_gone) as x(workspace_id uuid, source_type text, source_id uuid, ids uuid[]) loop
    v_tbl := public._custom_field_table(s.source_type);
    if v_tbl is null then continue; end if;
    v_table := null;
    if s.source_type = 'data_row' then
      select r.table_id into v_table from public.data_row r where r.id = s.source_id;
      if v_table is null then continue; end if;
    end if;
    -- Every relation field of the record's kind, a deleted column's too (its
    -- undo must not bring back a link to nothing).
    select array_agg(f.key) into v_keys
      from public.custom_field_definition f
     where f.workspace_id = s.workspace_id and f.entity_type = s.source_type
       and ((v_table is null and f.table_id is null) or f.table_id = v_table)
       and f.field_type = 'relation';
    if v_keys is null then continue; end if;
    execute format('update public.%I set custom_fields = public._custom_fields_without(custom_fields, $1, $2) where id = $3 and workspace_id = $4', v_tbl)
      using v_keys, s.ids, s.source_id, s.workspace_id;
    if v_table is not null then
      update public.data_table set version = version + 1, updated_at = now() where id = v_table;
    end if;
  end loop;
  return null;
end;
$$;

revoke all on function public.custom_field_links_forget() from public, anon, authenticated;

do $$
declare
  k record;
begin
  for k in select * from (values
    ('contact', 'contact'), ('company', 'company'), ('deal', 'deal'), ('action', 'actions'), ('project', 'projects'),
    ('initiative', 'initiative'), ('document', 'document'), ('capture', 'captures'), ('flow', 'flow'), ('data_row', 'data_row')
  ) v(kind, tbl) loop
    execute format('drop trigger if exists custom_field_links_forget on public.%I', k.tbl);
    execute format(
      'create trigger custom_field_links_forget after delete on public.%I referencing old table as old_rows '
      || 'for each statement execute function public.custom_field_links_forget(%L)', k.tbl, k.kind);
  end loop;
end $$;

notify pgrst, 'reload schema';
