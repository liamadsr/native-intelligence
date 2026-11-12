-- ============================================================
-- 526: a kind's field changes type, with undo (Tables, phase 2).
-- ============================================================
-- A table's column changes type in its own write path (525's
-- change_column_type, logged in data_change). A kind's custom field (a
-- contact's, a deal's, a task's: table_id null) changes type here, by the
-- same cast rule (523's _field_convert), and is logged here for its undo:
--
--   1. custom_field_change: one row per type change: the field, who, its
--      type, options and config before and after, and every record's value
--      before and after. It holds values of records some members can't read,
--      so nobody reads it directly (RLS on, no policy): the two functions
--      below answer what is needed.
--   2. change_custom_field_type(definition, type, options, config): every
--      record of the kind in the workspace holding a value converts, the
--      ones the caller can't see too (a field is the workspace's, and its
--      type is one for every record), or nothing changes and the error says
--      how many values don't fit, with up to three examples from records the
--      caller CAN read. A select type given no options takes the values'
--      own. Any member but a guest, as any member defines fields (473).
--      Answers {change_id, converted, definition_id}.
--   3. undo_custom_field_change(change): the old type, options and config,
--      and each value as it was where it is still what the change made; a
--      value changed since converts back by the same rule, or the undo is
--      refused as a whole. Logged as a change of its own (undo_of), and
--      marks the one it takes back.
--
-- Locks, in one order: the records holding a value under the field's key
-- first, then the field itself (_custom_field_lock). A write of a record's
-- values locks the record, then share-locks its fields (524's
-- custom_field_values_fit), so the two never wait on each other in a
-- circle: a write already holding the record finishes first and is
-- converted; one that comes after reads the new type and is refused if its
-- value no longer fits.
-- A type change logs no 'updated' line per record (525's
-- dial8.field_retype); its log is this table.
--
-- After 523 and 525. Idempotent. No backslashes anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

create table if not exists public.custom_field_change (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  definition_id uuid not null references public.custom_field_definition(id) on delete cascade,
  actor_user_id uuid null references auth.users(id) on delete set null,
  -- A plain id, not a foreign key: a departed member's history survives them.
  actor_member_id uuid null,
  fields jsonb not null,
  "values" jsonb not null default '{}'::jsonb,
  undo_of uuid null references public.custom_field_change(id) on delete set null,
  undone_at timestamptz null,
  created_at timestamptz not null default now()
);

comment on table public.custom_field_change is
  'A kind''s custom field changing type (526): its type, options and config, and every record''s value, before and after. Read only through its functions.';

create index if not exists custom_field_change_definition_idx on public.custom_field_change (definition_id, created_at desc);

alter table public.custom_field_change enable row level security;
revoke all on table public.custom_field_change from anon, authenticated;
grant all on table public.custom_field_change to service_role;

-- The work both functions share: convert the field's values (with `restore`
-- for an undo), write them and the definition, log it. Locks held by the caller.
create or replace function public._custom_field_retype(
  d public.custom_field_definition,
  p_user uuid,
  p_member uuid,
  p_type text,
  p_options text[],
  p_config jsonb,
  p_restore jsonb,
  p_undo_of uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tbl text := public._custom_field_table(d.entity_type);
  v_now jsonb;
  v_conv jsonb;
  v_options text[] := coalesce(p_options, '{}');
  v_config jsonb := coalesce(p_config, '{}'::jsonb);
  v_examples text;
  v_change uuid;
begin
  if v_tbl is null or d.entity_type = 'data_row' then
    raise exception 'a table''s column changes type through its table' using errcode = '22023';
  end if;
  if p_type is null or p_type not in ('text', 'number', 'date', 'select', 'multi_select', 'checkbox', 'url', 'email', 'phone', 'person', 'currency', 'relation') then
    raise exception 'unknown type %', coalesce(p_type, '(none)') using errcode = '22023';
  end if;
  if not public._field_config_ok(p_type, v_config) or v_config ? 'required_when' then
    raise exception 'that setting does not fit field %', d.label using errcode = '22023';
  end if;

  execute format(
    'select coalesce(jsonb_object_agg(id::text, custom_fields -> $2), ''{}''::jsonb) from public.%I '
    || 'where workspace_id = $1 and custom_fields ? $2 and jsonb_typeof(custom_fields -> $2) <> ''null''', v_tbl)
    into v_now using d.workspace_id, d.key;

  if p_type in ('select', 'multi_select') then
    if cardinality(v_options) = 0 then
      v_options := public._field_options_from(d.field_type, p_type, v_now);
      if cardinality(v_options) > 50 then
        raise exception '% holds % different values: a select takes at most 50 options', d.label, cardinality(v_options) using errcode = '22023';
      end if;
    end if;
  else
    v_options := '{}';
  end if;

  v_conv := public._field_convert(v_now, d.field_type, d.config, p_type, v_options, v_config, p_restore);
  if (v_conv ->> 'misfits')::int > 0 then
    -- Examples only from records the caller can read: a count says nothing of the rest.
    select string_agg('“' || left(x ->> 'value', 40) || '”', ', ') into v_examples
      from (select x from jsonb_array_elements(v_conv -> 'examples') x
             where public.entity_visible_to(d.entity_type, (x ->> 'id')::uuid, d.workspace_id, p_user)
             limit 3) e;
    raise exception '% % fit %. Nothing was changed.',
      case when (v_conv ->> 'misfits')::int = 1 then '1 value' else (v_conv ->> 'misfits') || ' values' end,
      case when (v_conv ->> 'misfits')::int = 1 then 'doesn''t' else 'don''t' end,
      replace(p_type, '_', ' ') || case when v_examples is null then '' else ', e.g. ' || v_examples end
      using errcode = '22023', detail = (v_conv ->> 'misfits');
  end if;

  -- 524's guard lets a type change, and only a type change, change the type.
  perform set_config('dial8.field_definition_write', 'on', true);
  update public.custom_field_definition set field_type = p_type, options = v_options, config = v_config where id = d.id;
  perform set_config('dial8.field_definition_write', '', true);
  perform set_config('dial8.field_retype', 'on', true);
  execute format(
    'update public.%I t set custom_fields = jsonb_set(t.custom_fields, array[$1], c.value) '
    || 'from jsonb_each($2) c where t.id = c.key::uuid and t.workspace_id = $3 and (t.custom_fields -> $1) is distinct from c.value', v_tbl)
    using d.key, v_conv -> 'values', d.workspace_id;
  perform set_config('dial8.field_retype', '', true);

  insert into public.custom_field_change (workspace_id, definition_id, actor_user_id, actor_member_id, fields, "values", undo_of)
  values (d.workspace_id, d.id, p_user, p_member,
          jsonb_build_object(
            'field_type', jsonb_build_object('from', d.field_type, 'to', p_type),
            'options', jsonb_build_object('from', to_jsonb(d.options), 'to', to_jsonb(v_options)),
            'config', jsonb_build_object('from', d.config, 'to', v_config)),
          coalesce((select jsonb_object_agg(c.key, jsonb_build_object('from', v_now -> c.key, 'to', c.value)) from jsonb_each(v_conv -> 'values') c), '{}'::jsonb),
          p_undo_of)
  returning id into v_change;
  return jsonb_build_object('change_id', v_change, 'converted', (select count(*) from jsonb_object_keys(v_conv -> 'values')), 'definition_id', d.id);
end;
$$;

revoke all on function public._custom_field_retype(public.custom_field_definition, uuid, uuid, text, text[], jsonb, jsonb, uuid) from public, anon, authenticated;

-- The records holding a value under a kind's field, then the field: locked
-- until this commits, in that order (see the header). Returns the field as
-- it is once locked.
create or replace function public._custom_field_lock(p_definition_id uuid)
returns public.custom_field_definition
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d public.custom_field_definition%rowtype;
  v_tbl text;
begin
  select * into d from public.custom_field_definition where id = p_definition_id and table_id is null;
  if not found then
    return null;
  end if;
  v_tbl := public._custom_field_table(d.entity_type);
  if v_tbl is not null then
    execute format('select count(*) from (select 1 from public.%I where workspace_id = $1 and custom_fields ? $2 for update) x', v_tbl)
      using d.workspace_id, d.key;
  end if;
  select * into d from public.custom_field_definition where id = p_definition_id and table_id is null for update;
  return d;
end;
$$;

revoke all on function public._custom_field_lock(uuid) from public, anon, authenticated;

create or replace function public.change_custom_field_type(
  p_definition_id uuid,
  p_field_type text,
  p_options text[] default '{}',
  p_config jsonb default '{}'::jsonb,
  p_as_user uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := public._data_writer(p_as_user);
  d public.custom_field_definition%rowtype;
  v_member uuid;
  v_role text;
begin
  if v_user is null then
    raise exception 'change_custom_field_type: no user' using errcode = '42501';
  end if;
  d := public._custom_field_lock(p_definition_id);
  if d.id is null then
    raise exception 'field not found' using errcode = 'P0002';
  end if;
  select m.id, m.role into v_member, v_role from public.member m where m.user_id = v_user and m.workspace_id = d.workspace_id;
  if v_member is null then
    raise exception 'field not found' using errcode = 'P0002';
  end if;
  if v_role = 'guest' then
    raise exception 'a guest can''t change fields' using errcode = '42501';
  end if;
  return public._custom_field_retype(d, v_user, v_member, p_field_type, p_options, p_config, null, null);
end;
$$;

create or replace function public.undo_custom_field_change(p_change_id uuid, p_as_user uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := public._data_writer(p_as_user);
  c public.custom_field_change%rowtype;
  d public.custom_field_definition%rowtype;
  v_member uuid;
  v_role text;
  v_result jsonb;
begin
  if v_user is null then
    raise exception 'undo_custom_field_change: no user' using errcode = '42501';
  end if;
  select * into c from public.custom_field_change where id = p_change_id for update;
  if not found then
    raise exception 'change not found' using errcode = 'P0002';
  end if;
  select m.id, m.role into v_member, v_role from public.member m where m.user_id = v_user and m.workspace_id = c.workspace_id;
  if v_member is null then
    raise exception 'change not found' using errcode = 'P0002';
  end if;
  if v_role = 'guest' then
    raise exception 'a guest can''t change fields' using errcode = '42501';
  end if;
  if c.undo_of is not null then
    raise exception 'that change was itself an undo' using errcode = '22023';
  end if;
  if c.undone_at is not null then
    raise exception 'that change was already undone' using errcode = '22023';
  end if;
  d := public._custom_field_lock(c.definition_id);
  if d.id is null then
    raise exception 'field not found' using errcode = 'P0002';
  end if;
  if d.field_type is distinct from (c.fields -> 'field_type' ->> 'to') then
    raise exception 'the field changed type again since: undo that first' using errcode = '22023';
  end if;
  v_result := public._custom_field_retype(
    d, v_user, v_member,
    c.fields -> 'field_type' ->> 'from',
    coalesce((select array_agg(x) from jsonb_array_elements_text(c.fields -> 'options' -> 'from') x), '{}'),
    coalesce(c.fields -> 'config' -> 'from', '{}'::jsonb),
    c."values",
    c.id);
  update public.custom_field_change set undone_at = now() where id = c.id;
  return v_result;
end;
$$;

revoke all on function public.change_custom_field_type(uuid, text, text[], jsonb, uuid) from public, anon;
revoke all on function public.undo_custom_field_change(uuid, uuid) from public, anon;
grant execute on function public.change_custom_field_type(uuid, text, text[], jsonb, uuid) to authenticated, service_role;
grant execute on function public.undo_custom_field_change(uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
