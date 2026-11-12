-- ============================================================
-- 540: Pipelines are tables (Tables, phase 7).
-- ============================================================
-- A pipeline is a table (520) marked `kind = 'pipeline'`, and a deal is one
-- of its rows: the row's title is the deal's name, and its own columns, the
-- system columns, hold the rest:
--
--   company         relation to a company (one)
--   contacts        relation to contacts (several)
--   value           currency
--   stage           select; each option's outcome (open, won or lost) is in
--                   the column's config, `outcomes` {option: 'won' | 'lost'}
--                   (an option not named there is open)
--   expected_close  date
--   owner           person
--
-- plus a Notes text column a new pipeline starts with, and whatever columns
-- people add. Stages are the stage column's options, edited like any select
-- column's; required_when (525) gives a stage its rules ("Won needs Value").
--
--   1. data_table.kind ('table' or 'pipeline') and data_table.is_default
--      (a pipeline only, one per workspace).
--   2. data_row.stage_changed_at and data_row.closed_at, kept by a trigger
--      on a pipeline's rows, as 473 kept a deal's: a new stage stamps
--      stage_changed_at; entering a won or lost stage stamps closed_at (one
--      already closed keeps its date), any other clears it. A change to the
--      stage column's outcomes stamps or clears the rows it moves.
--   3. custom_field_definition.system: a pipeline's own columns. One can be
--      renamed and its options and settings edited, never deleted, retyped,
--      re-keyed or pointed at another kind.
--   4. _field_config_ok takes `outcomes`, on a select only (531's, phase 6:
--      its formula and rollup settings stay).
--   5. create_pipeline(workspace, name, stages, ...): a new pipeline, through
--      create_data_table, in one transaction; ensure_default_pipeline(
--      workspace) returns the workspace's default pipeline, making "Sales"
--      (Lead, Qualified, Proposal, Won, Lost) the first time.
--   6. data_change.source_ref: the email, capture or text a change came
--      from; apply_data_ops (530's) takes p_source_ref.
--   7. The default pipeline is never archived or private (a trigger says
--      so); set_default_pipeline(table) makes another the default.
--
-- The deals themselves move in 548; the old deal tables go in 549.
-- Re-runnable. No backslashes anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. A table's kind, and the default pipeline
-- ------------------------------------------------------------

alter table public.data_table add column if not exists kind text not null default 'table';
alter table public.data_table add column if not exists is_default boolean not null default false;

comment on column public.data_table.kind is
  'table, or pipeline (540): a pipeline''s rows are deals, with its system columns (custom_field_definition.system).';
comment on column public.data_table.is_default is
  'The workspace''s default pipeline (540): where a deal goes when no pipeline is named. One per workspace.';

alter table public.data_table drop constraint if exists data_table_kind_check;
alter table public.data_table
  add constraint data_table_kind_check check (kind in ('table', 'pipeline'));
alter table public.data_table drop constraint if exists data_table_default_pipeline;
alter table public.data_table
  add constraint data_table_default_pipeline check (not is_default or kind = 'pipeline');

create unique index if not exists data_table_one_default_pipeline
  on public.data_table (workspace_id) where is_default;
create index if not exists data_table_pipeline_idx
  on public.data_table (workspace_id, position) where kind = 'pipeline';

-- ------------------------------------------------------------
-- 2. A deal's stage times
-- ------------------------------------------------------------

alter table public.data_row add column if not exists stage_changed_at timestamptz null;
alter table public.data_row add column if not exists closed_at timestamptz null;

comment on column public.data_row.stage_changed_at is
  'A pipeline''s row only (540): when its stage last changed.';
comment on column public.data_row.closed_at is
  'A pipeline''s row only (540): when it entered a won or lost stage; null while open.';

-- ------------------------------------------------------------
-- 3. System columns
-- ------------------------------------------------------------

alter table public.custom_field_definition add column if not exists system boolean not null default false;

comment on column public.custom_field_definition.system is
  'A pipeline''s own column (540): renamed and edited, never deleted, retyped or re-keyed.';

alter table public.custom_field_definition drop constraint if exists custom_field_definition_system_table;
alter table public.custom_field_definition
  add constraint custom_field_definition_system_table check (not system or table_id is not null);

-- ------------------------------------------------------------
-- 4. A select's outcomes (531's _field_config_ok, with `outcomes`)
-- ------------------------------------------------------------

create or replace function public._field_config_ok(p_type text, p_config jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_typeof(p_config) = 'object'
    and not exists (select 1 from jsonb_object_keys(p_config) k
                     where k not in ('currency', 'target', 'multiple', 'required_when', 'outcomes', 'expression', 'relation', 'fn', 'field'))
    and (not (p_config ? 'currency') or (p_type = 'currency' and (p_config ->> 'currency') ~ '^[A-Z]{3}$'))
    and (not (p_config ? 'multiple') or (p_type = 'relation' and jsonb_typeof(p_config -> 'multiple') = 'boolean'))
    and ((p_type = 'relation') = (p_config ? 'target'))
    and (p_type <> 'relation' or (
      jsonb_typeof(p_config -> 'target') = 'object'
      and (p_config -> 'target' ->> 'kind') in ('contact', 'company', 'deal', 'action', 'project', 'initiative', 'document', 'capture', 'flow', 'data_row')
      and ((p_config -> 'target' ->> 'kind') = 'data_row') = (p_config -> 'target' ? 'table_id')
      and (not (p_config -> 'target' ? 'table_id')
           or (p_config -> 'target' ->> 'table_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')))
    and (not (p_config ? 'required_when') or (
      jsonb_typeof(p_config -> 'required_when') = 'object'
      and jsonb_typeof(p_config -> 'required_when' -> 'key') = 'string'
      and jsonb_typeof(p_config -> 'required_when' -> 'option') = 'string'))
    and (not (p_config ? 'outcomes') or (
      p_type = 'select'
      and jsonb_typeof(p_config -> 'outcomes') = 'object'
      and not exists (select 1 from jsonb_each(p_config -> 'outcomes') o
                       where jsonb_typeof(o.value) <> 'string' or (o.value #>> '{}') not in ('open', 'won', 'lost'))))
    -- A formula: its expression, and nothing a rollup has (phase 6, 531).
    and ((p_type = 'formula') = (p_config ? 'expression'))
    and (p_type <> 'formula' or (
      jsonb_typeof(p_config -> 'expression') = 'string'
      and char_length(p_config ->> 'expression') between 1 and 2000))
    -- A rollup: its relation and function, a field or none (531).
    and ((p_type = 'rollup') = (p_config ? 'relation'))
    and ((p_type = 'rollup') = (p_config ? 'fn'))
    and (not (p_config ? 'field') or p_type = 'rollup')
    and (p_type <> 'rollup' or (
      (p_config ->> 'relation') ~ '^[a-z][a-z0-9_]{0,39}$'
      and (p_config ->> 'fn') in ('count', 'sum', 'avg', 'min', 'max', 'earliest', 'latest', 'list')
      and (not (p_config ? 'field') or jsonb_typeof(p_config -> 'field') = 'null'
           or (p_config ->> 'field') ~ '^([a-z][a-z0-9_]{0,39}|_title)$'))),
    false);
$$;
revoke all on function public._field_config_ok(text, jsonb) from public, anon, authenticated;

-- A system column keeps what makes it the pipeline's: its key, type, table
-- and (a relation) what it links. It goes only with its table.
create or replace function public.pipeline_column_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not old.system or coalesce(current_setting('dial8.workspace_merge', true), '') <> '' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    -- A table being deleted takes its columns with it.
    if exists (select 1 from public.data_table t where t.id = old.table_id) then
      raise exception '% is a pipeline''s own column: it can''t be deleted', old.label using errcode = '22023';
    end if;
    return old;
  end if;
  if new.deleted_at is not null and old.deleted_at is null then
    raise exception '% is a pipeline''s own column: it can''t be deleted', old.label using errcode = '22023';
  end if;
  if new.field_type is distinct from old.field_type or new.key is distinct from old.key
     or new.table_id is distinct from old.table_id or not new.system then
    raise exception '% is a pipeline''s own column: it keeps its type', old.label using errcode = '22023';
  end if;
  if (new.config -> 'target') is distinct from (old.config -> 'target')
     or (new.config -> 'multiple') is distinct from (old.config -> 'multiple') then
    raise exception '% is a pipeline''s own column: it keeps what it links', old.label using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function public.pipeline_column_guard() from public, anon, authenticated;

drop trigger if exists pipeline_column_guard on public.custom_field_definition;
create trigger pipeline_column_guard
  before update or delete on public.custom_field_definition
  for each row execute function public.pipeline_column_guard();

-- ------------------------------------------------------------
-- 2b. The stage times, kept
-- ------------------------------------------------------------

-- A stage's outcome in a pipeline: 'won', 'lost' or 'open' (any other, or none).
create or replace function public.pipeline_stage_outcome(p_table uuid, p_stage text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select case when (f.config -> 'outcomes' ->> p_stage) in ('won', 'lost') then f.config -> 'outcomes' ->> p_stage end
      from public.custom_field_definition f
     where f.table_id = p_table and f.key = 'stage' and f.system
     limit 1), 'open');
$$;

revoke all on function public.pipeline_stage_outcome(uuid, text) from public, anon, authenticated;

create or replace function public.pipeline_row_stage()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_new text := new.custom_fields ->> 'stage';
  v_outcome text;
begin
  if coalesce(current_setting('dial8.workspace_merge', true), '') <> '' then
    return new;
  end if;
  if not exists (select 1 from public.data_table t where t.id = new.table_id and t.kind = 'pipeline') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    -- A row moved in with its times (548) keeps them.
    new.stage_changed_at := coalesce(new.stage_changed_at, now());
  elsif v_new is distinct from (old.custom_fields ->> 'stage') then
    new.stage_changed_at := now();
  else
    return new;
  end if;
  v_outcome := case when v_new is null then 'open' else public.pipeline_stage_outcome(new.table_id, v_new) end;
  if v_outcome in ('won', 'lost') then
    new.closed_at := coalesce(case when tg_op = 'UPDATE' then old.closed_at end, new.closed_at, now());
  else
    new.closed_at := null;
  end if;
  return new;
end;
$$;

revoke all on function public.pipeline_row_stage() from public, anon, authenticated;

drop trigger if exists pipeline_row_stage on public.data_row;
create trigger pipeline_row_stage
  before insert or update of custom_fields on public.data_row
  for each row execute function public.pipeline_row_stage();

-- The stage column's outcomes changed: the rows they close or open again.
create or replace function public.pipeline_outcomes_changed()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(current_setting('dial8.workspace_merge', true), '') <> '' then
    return null;
  end if;
  update public.data_row r
     set closed_at = case when (new.config -> 'outcomes' ->> (r.custom_fields ->> 'stage')) in ('won', 'lost') then coalesce(r.closed_at, now()) end
   where r.table_id = new.table_id
     and (r.closed_at is not null) is distinct from ((new.config -> 'outcomes' ->> (r.custom_fields ->> 'stage')) in ('won', 'lost'));
  return null;
end;
$$;

revoke all on function public.pipeline_outcomes_changed() from public, anon, authenticated;

drop trigger if exists pipeline_outcomes_changed on public.custom_field_definition;
create trigger pipeline_outcomes_changed
  after update of config on public.custom_field_definition
  for each row
  when (new.system and new.key = 'stage' and (old.config -> 'outcomes') is distinct from (new.config -> 'outcomes'))
  execute function public.pipeline_outcomes_changed();

-- ------------------------------------------------------------
-- 5. A new pipeline, and the default one
-- ------------------------------------------------------------

-- A pipeline's system columns and Notes, as create_data_table's ops. p_stages:
-- [{name, outcome}] in order; none gives Lead, Qualified, Proposal, Won, Lost.
create or replace function public._pipeline_column_ops(p_stages jsonb, p_currency text)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  with stages as (
    select s.ord, btrim(s.value ->> 'name') as name, coalesce(s.value ->> 'outcome', 'open') as outcome
      from jsonb_array_elements(case when jsonb_typeof(p_stages) = 'array' and jsonb_array_length(p_stages) > 0 then p_stages
        else '[{"name": "Lead"}, {"name": "Qualified"}, {"name": "Proposal"}, {"name": "Won", "outcome": "won"}, {"name": "Lost", "outcome": "lost"}]'::jsonb end)
        with ordinality s(value, ord)
     where btrim(coalesce(s.value ->> 'name', '')) <> ''
  )
  select jsonb_build_array(
    jsonb_build_object('op', 'create_column', 'key', 'stage', 'label', 'Stage', 'field_type', 'select',
      'options', (select coalesce(jsonb_agg(name order by ord), '[]'::jsonb) from stages),
      'config', jsonb_build_object('outcomes', (select coalesce(jsonb_object_agg(name, outcome), '{}'::jsonb) from stages where outcome in ('won', 'lost')))),
    jsonb_build_object('op', 'create_column', 'key', 'value', 'label', 'Value', 'field_type', 'currency',
      'config', jsonb_build_object('currency', coalesce(p_currency, 'USD'))),
    jsonb_build_object('op', 'create_column', 'key', 'company', 'label', 'Company', 'field_type', 'relation',
      'config', jsonb_build_object('target', jsonb_build_object('kind', 'company'), 'multiple', false)),
    jsonb_build_object('op', 'create_column', 'key', 'contacts', 'label', 'Contacts', 'field_type', 'relation',
      'config', jsonb_build_object('target', jsonb_build_object('kind', 'contact'), 'multiple', true)),
    jsonb_build_object('op', 'create_column', 'key', 'expected_close', 'label', 'Expected close', 'field_type', 'date'),
    jsonb_build_object('op', 'create_column', 'key', 'owner', 'label', 'Owner', 'field_type', 'person'),
    jsonb_build_object('op', 'create_column', 'key', 'notes', 'label', 'Notes', 'field_type', 'text'));
$$;

revoke all on function public._pipeline_column_ops(jsonb, text) from public, anon, authenticated;

-- The keys of a pipeline's system columns.
create or replace function public.pipeline_system_keys()
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  select array['stage', 'value', 'company', 'contacts', 'expected_close', 'owner'];
$$;

grant execute on function public.pipeline_system_keys() to authenticated, service_role;

-- A new pipeline: create_data_table's checks (a member, not a guest; the
-- caller, or on the service role p_as_user, owns it), its columns, then
-- marked a pipeline. Returns create_data_table's answer.
create or replace function public.create_pipeline(
  p_workspace_id uuid,
  p_name text,
  p_stages jsonb default null,
  p_source text default 'person',
  p_as_user uuid default null,
  p_reason text default null,
  p_default boolean default false,
  p_currency text default 'USD'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
  v_table uuid;
begin
  if p_currency is not null and p_currency !~ '^[A-Z]{3}$' then
    raise exception 'a currency is a three-letter code' using errcode = '22023';
  end if;
  v_result := public.create_data_table(p_workspace_id, p_name, 'workspace', null, null,
    public._pipeline_column_ops(p_stages, p_currency), p_source, p_as_user, p_reason, true);
  v_table := (v_result ->> 'table_id')::uuid;
  update public.data_table
     set kind = 'pipeline',
         is_default = p_default and not exists (select 1 from public.data_table d where d.workspace_id = p_workspace_id and d.is_default)
   where id = v_table;
  update public.custom_field_definition
     set system = true
   where table_id = v_table and key = any (public.pipeline_system_keys());
  return v_result;
end;
$$;

revoke all on function public.create_pipeline(uuid, text, jsonb, text, uuid, text, boolean, text) from public, anon;
grant execute on function public.create_pipeline(uuid, text, jsonb, text, uuid, text, boolean, text) to authenticated, service_role;

-- The workspace's default pipeline, made the first time ("Sales"). Null for
-- a guest when there is none yet: a guest makes no tables. Two first uses
-- at once settle on one (the lock, then the partial unique index).
create or replace function public.ensure_default_pipeline(p_workspace_id uuid, p_as_user uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := public._data_writer(p_as_user);
  v_role text;
  v_id uuid;
begin
  if v_user is null then
    raise exception 'ensure_default_pipeline: no user' using errcode = '42501';
  end if;
  select m.role into v_role from public.member m where m.user_id = v_user and m.workspace_id = p_workspace_id;
  if v_role is null then
    raise exception 'workspace not found' using errcode = 'P0002';
  end if;
  select id into v_id from public.data_table
   where workspace_id = p_workspace_id and is_default and archived_at is null and visibility = 'workspace';
  if v_id is not null then
    return v_id;
  end if;
  if v_role = 'guest' then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('default_pipeline:' || p_workspace_id::text, 0));
  select id into v_id from public.data_table
   where workspace_id = p_workspace_id and is_default and archived_at is null and visibility = 'workspace';
  if v_id is not null then
    return v_id;
  end if;
  return (public.create_pipeline(p_workspace_id, 'Sales', null, 'person', p_as_user, null, true) ->> 'table_id')::uuid;
end;
$$;

revoke all on function public.ensure_default_pipeline(uuid, uuid) from public, anon;
grant execute on function public.ensure_default_pipeline(uuid, uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 6. Where a change came from: data_change.source_ref
-- ------------------------------------------------------------
-- The email thread, capture or text a change came from (a deal's `because`
-- ref, kept by 473's deal_event): apply_data_ops takes p_source_ref, and the
-- change keeps it. 530's apply_data_ops otherwise, the old signature dropped
-- first (PostgREST would find two candidates).

alter table public.data_change add column if not exists source_ref text null;
alter table public.data_change drop constraint if exists data_change_source_ref_length;
alter table public.data_change
  add constraint data_change_source_ref_length check (source_ref is null or char_length(source_ref) <= 200);

drop function if exists public.apply_data_ops(uuid, bigint, jsonb, text, text, uuid, uuid, boolean);

create or replace function public.apply_data_ops(
  p_table_id uuid,
  p_base_version bigint,
  p_ops jsonb,
  p_source text default 'person',
  p_reason text default null,
  p_undo_of uuid default null,
  p_as_user uuid default null,
  p_grants boolean default true,
  p_source_ref text default null
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
  insert into public.data_change (workspace_id, table_id, version, actor_user_id, actor_member_id, source, reason, changes, undo_of, source_ref)
  values (t.workspace_id, t.id, v_version, v_user, v_member, p_source, nullif(btrim(coalesce(p_reason, '')), ''), v_result -> 'changes', p_undo_of,
          left(nullif(btrim(coalesce(p_source_ref, '')), ''), 200))
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

revoke all on function public.apply_data_ops(uuid, bigint, jsonb, text, text, uuid, uuid, boolean, text) from public, anon;
grant execute on function public.apply_data_ops(uuid, bigint, jsonb, text, text, uuid, uuid, boolean, text) to authenticated, service_role;


-- ------------------------------------------------------------
-- 7. The default pipeline stays open to the workspace
-- ------------------------------------------------------------
-- A deal named in no pipeline goes to the default, so the default is never
-- archived or private: make another the default first (set_default_pipeline).

create or replace function public.pipeline_default_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(current_setting('dial8.workspace_merge', true), '') <> '' then
    return new;
  end if;
  if new.is_default and (new.archived_at is not null or new.visibility <> 'workspace') then
    raise exception 'the default pipeline stays open to the workspace: make another pipeline the default first' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function public.pipeline_default_guard() from public, anon, authenticated;

drop trigger if exists pipeline_default_guard on public.data_table;
create trigger pipeline_default_guard
  before update of archived_at, visibility, is_default on public.data_table
  for each row execute function public.pipeline_default_guard();

-- Make a pipeline the workspace's default: a live, workspace-wide pipeline the
-- caller (on the service role, p_as_user) may change, and not a guest.
create or replace function public.set_default_pipeline(p_table_id uuid, p_as_user uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := public._data_writer(p_as_user);
  t public.data_table%rowtype;
  v_role text;
begin
  if v_user is null then
    raise exception 'set_default_pipeline: no user' using errcode = '42501';
  end if;
  select * into t from public.data_table where id = p_table_id and kind = 'pipeline' for update;
  if not found or not public.data_table_visible_to(t.id, v_user) then
    raise exception 'pipeline not found' using errcode = 'P0002';
  end if;
  select m.role into v_role from public.member m where m.user_id = v_user and m.workspace_id = t.workspace_id;
  if v_role is null or v_role = 'guest' or not public.data_table_editable_by(t.id, v_user) then
    raise exception 'you can view this pipeline but not change it' using errcode = '42501';
  end if;
  if t.archived_at is not null or t.visibility <> 'workspace' then
    raise exception 'the default pipeline stays open to the workspace: restore it, or share it with the workspace, first' using errcode = '22023';
  end if;
  if t.is_default then
    return t.id;
  end if;
  update public.data_table set is_default = false, updated_at = now() where workspace_id = t.workspace_id and is_default;
  update public.data_table set is_default = true, updated_at = now() where id = t.id;
  return t.id;
end;
$$;

revoke all on function public.set_default_pipeline(uuid, uuid) from public, anon;
grant execute on function public.set_default_pipeline(uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
