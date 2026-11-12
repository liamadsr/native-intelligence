-- Migration 530: Tables phase 5, the agent's table writes on a guest's turn.
--
-- A guest's or a linked agent's turn runs the person's tools, but a per-item
-- grant (492) shares a table with the PERSON, never with whoever they let
-- talk to their agent (519's rule). The reads already leave grants out there
-- (visible_data_table_ids with p_grants false, 520). This does the same for
-- the writes:
--
--   1. apply_data_ops and create_data_table take p_grants (default true).
--      False: the table must be one the writer reads without a grant
--      (data_table_visible_ungranted; a writer who reads it only through a
--      grant is told it isn't there), and the batch runs with
--      dial8.data_grants = 'off' for this transaction, so a relation value
--      links only what the writer reads without a grant (524's
--      custom_field_links_sync reads the flag).
--   2. create_data_table takes p_reason, so a table the agent makes says why
--      in its history, like every other batch.
--
-- Both restate 520's definitions (the newest), changed only there. The old
-- signatures go first: with both, PostgREST would find two candidates.

drop function if exists public.apply_data_ops(uuid, bigint, jsonb, text, text, uuid, uuid);

create or replace function public.apply_data_ops(
  p_table_id uuid,
  p_base_version bigint,
  p_ops jsonb,
  p_source text default 'person',
  p_reason text default null,
  p_undo_of uuid default null,
  p_as_user uuid default null,
  p_grants boolean default true
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
  -- Without grants (a guest's or a linked agent's turn), a table the writer
  -- reads only through a grant is not there for them.
  if not found
     or not public.data_table_visible_to(t.id, v_user)
     or (p_grants is false and not public.data_table_visible_ungranted(t.id, v_user)) then
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
  -- and this batch makes no new table. A relation value links without grants
  -- when the batch has none (524).
  perform set_config('dial8.data_source', p_source, true);
  perform set_config('dial8.data_new_table', '', true);
  perform set_config('dial8.data_grants', case when p_grants is false then 'off' else '' end, true);
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

revoke all on function public.apply_data_ops(uuid, bigint, jsonb, text, text, uuid, uuid, boolean) from public, anon;
grant execute on function public.apply_data_ops(uuid, bigint, jsonb, text, text, uuid, uuid, boolean) to authenticated, service_role;

drop function if exists public.create_data_table(uuid, text, text, text, text, jsonb, text, uuid);

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
  p_as_user uuid default null,
  p_reason text default null,
  p_grants boolean default true
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
  -- Starter rows link without grants when the batch has none (524).
  perform set_config('dial8.data_grants', case when p_grants is false then 'off' else '' end, true);
  v_result := public._data_apply(v_table, v_user, v_member, coalesce(p_ops, '[]'::jsonb));

  insert into public.data_change (workspace_id, table_id, version, actor_user_id, actor_member_id, source, reason, changes)
  values (p_workspace_id, v_table, 1, v_user, v_member, p_source, nullif(btrim(coalesce(p_reason, '')), ''),
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

revoke all on function public.create_data_table(uuid, text, text, text, text, jsonb, text, uuid, text, boolean) from public, anon;
grant execute on function public.create_data_table(uuid, text, text, text, text, jsonb, text, uuid, text, boolean) to authenticated, service_role;
