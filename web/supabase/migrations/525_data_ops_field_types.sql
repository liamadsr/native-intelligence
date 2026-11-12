-- ============================================================
-- 525: the write path takes the new field types (Tables, phase 2).
-- ============================================================
-- 520's write path, with the types of 523 and two new rules:
--
--   1. _data_merge_values checks each value with 523's _field_value_ok
--      (the column's config too: a relation single or several).
--   2. _data_apply:
--        create_column / update_column take `config` (checked by
--        _data_column_config_ok: 523's shape, a relation's table in this
--        workspace, a required_when naming another live select column of
--        this table and one of its options); a multi-select has options
--        like a select, and an option still in use can't go from either; a
--        setting rows no longer fit is refused with their count; a
--        relation keeps its target (a new one is a type change).
--        change_column_type {key, field_type, options?, config?, restore?}:
--        every row's value converts by 523's one cast rule, or the batch is
--        refused with how many don't fit and up to three of them by row. A
--        select type given no options takes the values' own. The change
--        logs every row's value before and after, so its undo
--        (src/lib/tables/ops.ts planUndo) gives each back, through
--        `restore`, where it is still what the change made.
--        Every batch names its writer for 524's relation fence
--        (dial8.data_writer, this transaction only), and may change a
--        column's type or settings (dial8.field_definition_write, while
--        its ops run: 524's guard refuses that to anyone else). A change to
--        a select type given no options keeps the column's own
--        (src/lib/tables/ops.ts sends them), or takes the values'.
--   3. Required when: a column whose config has required_when {key, option}
--      must have a value on a row whose select column `key` is `option`.
--      Checked once a batch has run (_data_required_check), for each row
--      the batch made, or whose `key` or the column itself it wrote: an old
--      row that never met the rule can still be renamed. src/lib/tables/ops.ts
--      requiredWhenProblem is the same rule in the app.
--
-- Every other line of both functions is 520's (with its review fixes: an
-- archived table takes only its restore, at most 5000 rows a batch).
--
-- After 520 and 523. Idempotent (create or replace). No backslashes
-- anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- Does a column's config fit it, in this table?
create or replace function public._data_column_config_ok(p_table public.data_table, p_key text, p_type text, p_config jsonb)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select public._field_config_ok(p_type, p_config)
     and (p_type <> 'relation' or (p_config -> 'target' ->> 'kind') <> 'data_row' or exists (
           select 1 from public.data_table x
            where x.id = (p_config -> 'target' ->> 'table_id')::uuid and x.workspace_id = p_table.workspace_id))
     and (not (p_config ? 'required_when') or exists (
           select 1 from public.custom_field_definition w
            where w.table_id = p_table.id
              and w.key = (p_config -> 'required_when' ->> 'key')
              and w.key <> p_key
              and w.deleted_at is null
              and w.field_type = 'select'
              and (p_config -> 'required_when' ->> 'option') = any (w.options)));
$$;

revoke all on function public._data_column_config_ok(public.data_table, text, text, jsonb) from public, anon, authenticated;

-- Required when: the first row of p_touched ({row_id: [value keys written,
-- or '*' for a new row]}) that leaves a required column empty.
create or replace function public._data_required_check(p_table uuid, p_touched jsonb)
returns void
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  c record;
  r record;
begin
  if p_touched is null or p_touched = '{}'::jsonb then
    return;
  end if;
  for c in
    select d.key, d.label, w.key as when_key, w.label as when_label, d.config -> 'required_when' ->> 'option' as when_option
      from public.custom_field_definition d
      join public.custom_field_definition w
        on w.table_id = d.table_id and w.key = d.config -> 'required_when' ->> 'key'
       and w.deleted_at is null and w.field_type = 'select'
     where d.table_id = p_table and d.deleted_at is null and d.config ? 'required_when'
  loop
    select dr.title into r
      from public.data_row dr
      join jsonb_each(p_touched) tc on tc.key = dr.id::text
     where dr.table_id = p_table
       and dr.archived_at is null
       and (dr.custom_fields ->> c.when_key) = c.when_option
       and coalesce(jsonb_typeof(dr.custom_fields -> c.key), 'null') = 'null'
       and (tc.value ? '*' or tc.value ? c.when_key or tc.value ? c.key)
     limit 1;
    if found then
      raise exception '% is needed when % is % (row “%”)', c.label, c.when_label, c.when_option, coalesce(nullif(r.title, ''), 'Untitled')
        using errcode = '22023';
    end if;
  end loop;
end;
$$;

revoke all on function public._data_required_check(uuid, jsonb) from public, anon, authenticated;

-- _data_merge_values, from 520_data_tables.sql, with 523's floor.
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
    select d.field_type, d.options, d.config into col
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
    elsif not public._field_value_ok(col.field_type, col.options, col.config, v) then
      raise exception 'that value does not fit column %', k using errcode = '22023';
    else
      out := out || jsonb_build_object(k, v);
    end if;
  end loop;
  return out;
end;
$$;

revoke all on function public._data_merge_values(public.data_table, jsonb, jsonb) from public, anon, authenticated;

-- _data_apply, from 520_data_tables.sql, with the new op, settings and rules.
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
  v_rows int := 0;
  v_config jsonb;
  v_values_now jsonb;
  v_conv jsonb;
  v_touched jsonb := '{}'::jsonb;
  v_examples text;
begin
  if p_ops is null or jsonb_typeof(p_ops) <> 'array' then
    raise exception 'ops must be a list' using errcode = '22023';
  end if;
  if jsonb_array_length(p_ops) > 500 then
    raise exception 'at most 500 ops in one batch' using errcode = '22023';
  end if;
  -- Who writes, for the relation fence (524): this transaction only.
  perform set_config('dial8.data_writer', coalesce(p_user::text, ''), true);
  -- Its column ops may change a column's type or settings (524's guard lets only these).
  perform set_config('dial8.field_definition_write', 'on', true);

  for op in select value from jsonb_array_elements(p_ops) loop
    select * into t from public.data_table where id = p_table_id;
    kind := op ->> 'op';
    -- An archived table takes nothing but its restore (or archive) until that runs.
    if t.archived_at is not null and kind not in ('restore_table', 'archive_table') then
      raise exception 'the table is archived: restore it first' using errcode = '22023';
    end if;
    -- Rows a batch inserts, archives or restores, all its ops together: at most 5000.
    if kind = 'insert_rows' and jsonb_typeof(op -> 'rows') = 'array' then
      v_rows := v_rows + jsonb_array_length(op -> 'rows');
    elsif kind in ('archive_rows', 'restore_rows') and jsonb_typeof(op -> 'row_ids') = 'array' then
      v_rows := v_rows + jsonb_array_length(op -> 'row_ids');
    end if;
    if v_rows > 5000 then
      raise exception 'at most 5000 rows in one batch' using errcode = '22023';
    end if;

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
      -- Where a private table lives is its owner's call, as who sees it is
      -- (an edit grant opens what it says, 512).
      if t.visibility = 'private' and t.owner_member_id is distinct from p_member then
        raise exception 'only the table''s owner can archive it' using errcode = '42501';
      end if;
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
      v_config := coalesce(op -> 'config', '{}'::jsonb);
      if exists (select 1 from public.custom_field_definition d
                  where d.workspace_id = t.workspace_id and d.entity_type = 'data_row' and d.table_id = t.id and d.key = v_key) then
        raise exception 'a column with key % already exists', v_key using errcode = '22023';
      end if;
      if not public._data_column_config_ok(t, v_key, v_type, v_config) then
        raise exception 'that setting does not fit column %', v_key using errcode = '22023';
      end if;
      insert into public.custom_field_definition (workspace_id, entity_type, table_id, key, label, field_type, options, config, position)
      values (t.workspace_id, 'data_row', t.id, v_key, v_label, v_type,
              case when v_type in ('select', 'multi_select') then v_options else '{}' end, v_config,
              coalesce((select max(d.position) + 1 from public.custom_field_definition d where d.table_id = t.id), 0))
      returning * into col;
      created_cols := created_cols || jsonb_build_object(col.key, col.id);
      changes := changes || jsonb_build_array(jsonb_build_object(
        'op', kind, 'key', col.key, 'column_id', col.id, 'label', col.label, 'field_type', col.field_type, 'options', to_jsonb(col.options), 'config', col.config));

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
        if op ? 'options' and col.field_type in ('select', 'multi_select') then
          v_options := coalesce((select array_agg(x) from jsonb_array_elements_text(op -> 'options') x), '{}');
          if v_options is distinct from col.options then
            select count(*) into v_n from public.data_row dr
             where dr.table_id = t.id and dr.custom_fields ? v_key and not public._field_value_ok(col.field_type, v_options, col.config, dr.custom_fields -> v_key);
            if v_n > 0 then
              raise exception '% still % an option that would go', case when v_n = 1 then '1 row' else v_n || ' rows' end,
                case when v_n = 1 then 'has' else 'have' end using errcode = '22023';
            end if;
            fields := fields || jsonb_build_object('options', jsonb_build_object('from', to_jsonb(col.options), 'to', to_jsonb(v_options)));
          end if;
        end if;
        -- Its settings (523): a currency's code, a relation's several, a
        -- required_when. A relation keeps its target: a new one is a type change.
        if op ? 'config' and coalesce(op -> 'config', '{}'::jsonb) is distinct from col.config then
          v_config := coalesce(op -> 'config', '{}'::jsonb);
          if not public._data_column_config_ok(t, v_key, col.field_type, v_config) then
            raise exception 'that setting does not fit column %', v_key using errcode = '22023';
          end if;
          if col.field_type = 'relation' and (v_config -> 'target') is distinct from (col.config -> 'target') then
            raise exception 'column % links to something else: change its type to link it elsewhere', v_key using errcode = '22023';
          end if;
          select count(*) into v_n from public.data_row dr
           where dr.table_id = t.id and dr.custom_fields ? v_key
             and not public._field_value_ok(col.field_type, col.options, v_config, dr.custom_fields -> v_key);
          if v_n > 0 then
            raise exception '% would not fit the new setting', case when v_n = 1 then '1 row' else v_n || ' rows' end using errcode = '22023';
          end if;
          fields := fields || jsonb_build_object('config', jsonb_build_object('from', col.config, 'to', v_config));
        end if;
        if fields <> '{}'::jsonb then
          update public.custom_field_definition
             set label = case when fields ? 'label' then btrim(op ->> 'label') else label end,
                 options = case when fields ? 'options' then v_options else options end,
                 config = case when fields ? 'config' then v_config else config end
           where id = col.id;
          changes := changes || jsonb_build_array(jsonb_build_object('op', kind, 'key', v_key, 'fields', fields));
        end if;
      elsif (kind = 'delete_column') = (col.deleted_at is null) then
        update public.custom_field_definition
           set deleted_at = case when kind = 'delete_column' then now() end
         where id = col.id;
        changes := changes || jsonb_build_array(jsonb_build_object('op', kind, 'key', v_key));
      end if;

    elsif kind = 'change_column_type' then
      -- Another type (523): every row's value, archived rows too, converts by
      -- the one cast rule, or the batch is refused with how many don't fit
      -- and a few of them. Nothing is dropped. `restore` (an undo) gives a
      -- value back where it is still what the change made. The log keeps
      -- every row's value before and after.
      v_key := op ->> 'key';
      select * into col from public.custom_field_definition d
       where d.workspace_id = t.workspace_id and d.entity_type = 'data_row' and d.table_id = t.id and d.key = v_key and d.deleted_at is null;
      if not found then
        raise exception 'no column %', v_key using errcode = '22023';
      end if;
      v_type := op ->> 'field_type';
      v_options := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(op -> 'options', '[]'::jsonb)) x), '{}');
      v_config := coalesce(op -> 'config', '{}'::jsonb);
      if v_type is null or v_type not in ('text', 'number', 'date', 'select', 'multi_select', 'checkbox', 'url', 'email', 'phone', 'person', 'currency', 'relation') then
        raise exception 'unknown type %', coalesce(v_type, '(none)') using errcode = '22023';
      end if;
      if not public._data_column_config_ok(t, v_key, v_type, v_config) then
        raise exception 'that setting does not fit column %', v_key using errcode = '22023';
      end if;
      select coalesce(jsonb_object_agg(dr.id::text, dr.custom_fields -> v_key), '{}'::jsonb) into v_values_now
        from public.data_row dr
       where dr.table_id = t.id and dr.custom_fields ? v_key and jsonb_typeof(dr.custom_fields -> v_key) <> 'null';
      -- A select type named no options takes the values' own.
      if v_type in ('select', 'multi_select') and cardinality(v_options) = 0 then
        v_options := public._field_options_from(col.field_type, v_type, v_values_now);
        if cardinality(v_options) > 50 then
          raise exception 'column % holds % different values: a select takes at most 50 options', v_key, cardinality(v_options) using errcode = '22023';
        end if;
      elsif v_type not in ('select', 'multi_select') then
        v_options := '{}';
      end if;
      v_conv := public._field_convert(v_values_now, col.field_type, col.config, v_type, v_options, v_config, op -> 'restore');
      if (v_conv ->> 'misfits')::int > 0 then
        select string_agg(format('%s (%s)', '“' || left(x ->> 'value', 40) || '”', coalesce(nullif(dr.title, ''), 'Untitled')), ', ')
          into v_examples
          from (select x from jsonb_array_elements(v_conv -> 'examples') x limit 3) e
          left join public.data_row dr on dr.id = (e.x ->> 'id')::uuid;
        raise exception '% % fit %: %. Nothing was changed.',
          case when (v_conv ->> 'misfits')::int = 1 then '1 value' else (v_conv ->> 'misfits') || ' values' end,
          case when (v_conv ->> 'misfits')::int = 1 then 'doesn''t' else 'don''t' end,
          replace(v_type, '_', ' '), coalesce(v_examples, 'none of them shown')
          using errcode = '22023', detail = (v_conv ->> 'misfits');
      end if;
      if v_type <> col.field_type or v_options is distinct from col.options or v_config is distinct from col.config
         or exists (select 1 from jsonb_each(v_conv -> 'values') c where c.value is distinct from (v_values_now -> c.key)) then
        update public.custom_field_definition
           set field_type = v_type, options = v_options, config = v_config
         where id = col.id;
        -- One line in the table's history, not one 'updated' per row (525).
        perform set_config('dial8.field_retype', 'on', true);
        update public.data_row dr
           set custom_fields = jsonb_set(dr.custom_fields, array[v_key], c.value), updated_at = now()
          from jsonb_each(v_conv -> 'values') c
         where dr.id = c.key::uuid and dr.table_id = t.id and (dr.custom_fields -> v_key) is distinct from c.value;
        perform set_config('dial8.field_retype', '', true);
        changes := changes || jsonb_build_array(jsonb_build_object(
          'op', kind, 'key', v_key,
          'fields', jsonb_build_object(
            'field_type', jsonb_build_object('from', col.field_type, 'to', v_type),
            'options', jsonb_build_object('from', to_jsonb(col.options), 'to', to_jsonb(v_options)),
            'config', jsonb_build_object('from', col.config, 'to', v_config)),
          'values', coalesce((select jsonb_object_agg(c.key, jsonb_build_object('from', v_values_now -> c.key, 'to', c.value))
                                from jsonb_each(v_conv -> 'values') c), '{}'::jsonb)));
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
      select v_touched || coalesce(jsonb_object_agg(e ->> 'id', '["*"]'::jsonb), '{}'::jsonb) into v_touched
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
        v_touched := v_touched || jsonb_build_object(r.id::text,
          coalesce(v_touched -> (r.id::text), '[]'::jsonb)
          || coalesce((select jsonb_agg(substr(k, 8)) from jsonb_object_keys(fields) k where k like 'values.%'), '[]'::jsonb));
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

  perform set_config('dial8.field_definition_write', '', true);
  -- Required when (525): checked once the whole batch has run.
  perform public._data_required_check(p_table_id, v_touched);

  return jsonb_build_object('changes', changes, 'inserted_row_ids', inserted, 'created_column_ids', created_cols);
end;
$$;

revoke all on function public._data_apply(uuid, uuid, uuid, jsonb) from public, anon, authenticated;


-- A type change converts many records at once: it logs no 'updated' line
-- per record (489's rule, with dial8.field_retype; the table's own history,
-- or 526's log for a kind's field, says what changed).
create or replace function public.entity_activity_writable(p_workspace uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select p_workspace is not null
     and coalesce(current_setting('dial8.workspace_merge', true), '') = ''
     and coalesce(current_setting('dial8.field_retype', true), '') = ''
     and exists (select 1 from public.workspace w where w.id = p_workspace);
$$;
revoke all on function public.entity_activity_writable(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
