-- ============================================================
-- 541: a contact merge carries the rows that link the contact (Tables, phase 7).
-- ============================================================
-- 473 moved a merged-away contact's deals to the survivor through two
-- triggers on contact_merge. A deal is a pipeline's row now (540), and its
-- contacts a relation value, so the same two triggers work on relation
-- values: every table's relation column that links contacts, a pipeline's
-- Contacts among them.
--
--   On the merge row's insert: each row holding the loser holds the
--   survivor instead (a row holding both just drops the loser), and what
--   moved goes into contact_merge.moved (relation_rows: {row_id, key,
--   had_target}).
--   On its undo (undone_at set): those rows hold the restored contact again,
--   in the survivor's place or beside it.
--
-- Each write is a plain update of the row's values, so 524's triggers keep
-- the field_link edges in step; the edge to the contact coming back is made
-- first, as it was before the merge, so the link is not checked again (a
-- restored contact may not be readable yet while the undo runs). The tables
-- touched bump their version, so their viewers read again.
--
-- 473's deal triggers stay until 549 drops them with the deal tables.
-- Re-runnable. No backslashes anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- A relation value with one id put in another's place (or just dropped when
-- the other is there already).
create or replace function public._relation_value_swap(p_value jsonb, p_from uuid, p_to uuid)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when jsonb_typeof(p_value) <> 'array' then p_value
    when p_value @> to_jsonb(array[p_to::text]) then (
      select coalesce(jsonb_agg(e order by o), '[]'::jsonb) from jsonb_array_elements(p_value) with ordinality x(e, o) where e <> to_jsonb(p_from::text))
    else (
      select coalesce(jsonb_agg(case when e = to_jsonb(p_from::text) then to_jsonb(p_to::text) else e end order by o), '[]'::jsonb)
        from jsonb_array_elements(p_value) with ordinality x(e, o))
  end;
$$;

revoke all on function public._relation_value_swap(jsonb, uuid, uuid) from public, anon, authenticated;

create or replace function public.contact_merge_move_relations()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c record;
  r record;
  v_moved jsonb := '[]'::jsonb;
  v_tables uuid[] := '{}';
  v_had boolean;
begin
  if new.source_contact_id is null or new.target_contact_id is null then
    return new;
  end if;
  for c in
    select f.table_id, f.key
      from public.custom_field_definition f
     where f.workspace_id = new.workspace_id
       and f.table_id is not null
       and f.field_type = 'relation'
       and f.config -> 'target' ->> 'kind' = 'contact'
       and f.deleted_at is null
  loop
    for r in
      select x.id, x.custom_fields -> c.key as v
        from public.data_row x
       where x.table_id = c.table_id
         and x.custom_fields -> c.key @> to_jsonb(array[new.source_contact_id::text])
         for update
    loop
      v_had := r.v @> to_jsonb(array[new.target_contact_id::text]);
      if not v_had then
        insert into public.entity_link (workspace_id, source_type, source_id, target_type, target_id, relation)
        values (new.workspace_id, 'data_row', r.id, 'contact', new.target_contact_id, 'field_link')
        on conflict (workspace_id, source_type, source_id, target_type, target_id, relation) do nothing;
      end if;
      update public.data_row
         set custom_fields = jsonb_set(custom_fields, array[c.key], public._relation_value_swap(r.v, new.source_contact_id, new.target_contact_id)),
             updated_at = now()
       where id = r.id;
      v_moved := v_moved || jsonb_build_array(jsonb_build_object('row_id', r.id, 'key', c.key, 'had_target', v_had));
      v_tables := array_append(v_tables, c.table_id);
    end loop;
  end loop;
  if array_length(v_tables, 1) > 0 then
    update public.data_table set version = version + 1, updated_at = now() where id = any (v_tables);
  end if;
  new.moved := coalesce(new.moved, '{}'::jsonb) || jsonb_build_object('relation_rows', v_moved);
  return new;
end;
$$;

revoke all on function public.contact_merge_move_relations() from public, anon, authenticated;

drop trigger if exists contact_merge_move_relations on public.contact_merge;
create trigger contact_merge_move_relations
  before insert on public.contact_merge
  for each row execute function public.contact_merge_move_relations();

create or replace function public.contact_unmerge_restore_relations()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  m jsonb;
  r record;
  v_next jsonb;
  v_tables uuid[] := '{}';
begin
  if old.undone_at is not null or new.undone_at is null
     or new.source_contact_id is null or new.target_contact_id is null then
    return new;
  end if;
  for m in select * from jsonb_array_elements(coalesce(new.moved -> 'relation_rows', '[]'::jsonb)) loop
    select x.id, x.table_id, x.custom_fields -> (m ->> 'key') as v into r
      from public.data_row x
     where x.id = (m ->> 'row_id')::uuid and x.workspace_id = new.workspace_id
       for update;
    if not found or r.v @> to_jsonb(array[new.source_contact_id::text]) then
      continue;
    end if;
    if (m ->> 'had_target')::boolean then
      -- It held both: the restored contact comes back beside the survivor.
      v_next := case when jsonb_typeof(r.v) = 'array' then r.v || to_jsonb(array[new.source_contact_id::text]) else to_jsonb(array[new.source_contact_id::text]) end;
    elsif jsonb_typeof(r.v) = 'array' and r.v @> to_jsonb(array[new.target_contact_id::text]) then
      -- The survivor hands the place back.
      v_next := public._relation_value_swap(r.v, new.target_contact_id, new.source_contact_id);
    else
      continue;
    end if;
    insert into public.entity_link (workspace_id, source_type, source_id, target_type, target_id, relation)
    values (new.workspace_id, 'data_row', r.id, 'contact', new.source_contact_id, 'field_link')
    on conflict (workspace_id, source_type, source_id, target_type, target_id, relation) do nothing;
    update public.data_row
       set custom_fields = jsonb_set(custom_fields, array[m ->> 'key'], v_next),
           updated_at = now()
     where id = r.id;
    v_tables := array_append(v_tables, r.table_id);
  end loop;
  if array_length(v_tables, 1) > 0 then
    update public.data_table set version = version + 1, updated_at = now() where id = any (v_tables);
  end if;
  return new;
end;
$$;

revoke all on function public.contact_unmerge_restore_relations() from public, anon, authenticated;

drop trigger if exists contact_unmerge_restore_relations on public.contact_merge;
create trigger contact_unmerge_restore_relations
  after update of undone_at on public.contact_merge
  for each row execute function public.contact_unmerge_restore_relations();
