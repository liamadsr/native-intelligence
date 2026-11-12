-- ============================================================
-- 548: every deal becomes a pipeline's row (Tables, phase 7).
-- ============================================================
-- Moves 473's deals onto 540's pipeline tables, keeping every id, so a link,
-- a mention, a card or an activity row that named a deal names its row:
--
--   deal_pipeline   a pipeline table of the same id and name (the default
--                   stays the default), with the system columns, a Notes
--                   column, and a column for each of the workspace's deal
--                   custom fields (a key a system column has takes _2).
--                   Stages are the Stage column's options, in order, with
--                   won and lost as their outcomes (two stages of one name:
--                   the second is "Name (2)").
--   deal            a row of the same id: title = name; stage, value
--                   {amount, currency}, company [id], contacts [ids],
--                   expected_close, owner, notes (its first 2000
--                   characters), its custom values under their columns'
--                   keys; its stage_changed_at, closed_at, creator and
--                   times. 524's triggers make the company and contact
--                   edges (field_link).
--   deal_event      a data_change of the same id on the row's table, in
--                   order after the table's first change (its columns):
--                   created is the row's insert, updated / moved / undo
--                   are the row's field changes ({title}, {values.<key>}),
--                   with the event's source, reason, actor and undone
--                   time; an undo names the change it took back.
--                   What can't be undone: a change that moved a deal to
--                   another pipeline keeps its other fields, not the stage
--                   (a row stays in its table); a change with nothing else
--                   is left out. A deal's history from before its first
--                   logged change was never logged.
--   entity_link     an edge from or to a deal is the row's (one the row's
--                   own relation values made already is not doubled).
--   entity_activity a deal's history is the row's; a stage change names the
--                   stages, not their ids.
--   view            a view of deals is a view of the default pipeline's
--                   rows, a board by stage when it was a board.
--   team chat       a message's record_mentions name the row.
--   custom fields   a relation that linked deals links the default
--                   pipeline's rows; the deal fields themselves go.
--
-- Grants (492) never took deals (entity_access lists no 'deal'), so none
-- move. Re-runnable: what is already there is left as it is, so a second
-- run adds only what came since. After 549 drops the deal tables it does
-- nothing. No backslashes anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- One deal_event's changes as a data_change's: null when nothing in it maps.
create or replace function public._deal_event_changes(p_kind text, p_changes jsonb, p_deal_id uuid, p_deal_value numeric, p_deal_currency text, p_workspace uuid)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  k text;
  ch jsonb;
  f jsonb := '{}'::jsonb;
  v_cur_from text;
  v_cur_to text;
  v_amt_from jsonb;
  v_amt_to jsonb;
  v_key text;
begin
  if p_kind = 'created' then
    return jsonb_build_array(jsonb_build_object('op', 'insert_rows', 'row_ids', jsonb_build_array(p_deal_id)));
  end if;
  for k, ch in select * from jsonb_each(coalesce(p_changes, '{}'::jsonb)) loop
    if jsonb_typeof(ch) <> 'object' then
      continue;
    end if;
    if k = 'name' then
      f := f || jsonb_build_object('title', jsonb_build_object('from', coalesce(ch ->> 'from', ''), 'to', coalesce(ch ->> 'to', '')));
    elsif k = 'stage_id' then
      -- A move to another pipeline: the row stays in its table, so its stage
      -- can't go back to the other pipeline's.
      if not (p_changes ? 'pipeline_id') then
        f := f || jsonb_build_object('values.stage', jsonb_build_object(
          'from', (select to_jsonb(s.name) from pg_temp._d2p_stage s where s.id::text = ch ->> 'from'),
          'to', (select to_jsonb(s.name) from pg_temp._d2p_stage s where s.id::text = ch ->> 'to')));
      end if;
    elsif k = 'expected_close_date' then
      f := f || jsonb_build_object('values.expected_close', jsonb_build_object('from', ch -> 'from', 'to', ch -> 'to'));
    elsif k = 'owner_id' then
      f := f || jsonb_build_object('values.owner', jsonb_build_object('from', ch -> 'from', 'to', ch -> 'to'));
    elsif k = 'company_id' then
      f := f || jsonb_build_object('values.company', jsonb_build_object(
        'from', case when jsonb_typeof(ch -> 'from') = 'string' then jsonb_build_array(ch -> 'from') else 'null'::jsonb end,
        'to', case when jsonb_typeof(ch -> 'to') = 'string' then jsonb_build_array(ch -> 'to') else 'null'::jsonb end));
    elsif k = 'contact_ids' then
      f := f || jsonb_build_object('values.contacts', jsonb_build_object(
        'from', case when jsonb_typeof(ch -> 'from') = 'array' and jsonb_array_length(ch -> 'from') > 0 then ch -> 'from' else 'null'::jsonb end,
        'to', case when jsonb_typeof(ch -> 'to') = 'array' and jsonb_array_length(ch -> 'to') > 0 then ch -> 'to' else 'null'::jsonb end));
    elsif k = 'notes' then
      f := f || jsonb_build_object('values.notes', jsonb_build_object(
        'from', case when jsonb_typeof(ch -> 'from') = 'string' and (ch ->> 'from') <> '' then to_jsonb(left(ch ->> 'from', 2000)) else 'null'::jsonb end,
        'to', case when jsonb_typeof(ch -> 'to') = 'string' and (ch ->> 'to') <> '' then to_jsonb(left(ch ->> 'to', 2000)) else 'null'::jsonb end));
    elsif k like 'custom_fields.%' then
      select m.dst into v_key from pg_temp._d2p_key m where m.workspace_id = p_workspace and m.src = substr(k, 15);
      if v_key is not null then
        f := f || jsonb_build_object('values.' || v_key, jsonb_build_object('from', ch -> 'from', 'to', ch -> 'to'));
      end if;
    end if;
  end loop;
  -- The value is one currency field: its amount and code together.
  if p_changes ? 'value' or p_changes ? 'currency' then
    v_cur_from := coalesce(p_changes -> 'currency' ->> 'from', p_deal_currency);
    v_cur_to := coalesce(p_changes -> 'currency' ->> 'to', p_deal_currency);
    v_amt_from := case when p_changes ? 'value' then p_changes -> 'value' -> 'from' else to_jsonb(p_deal_value) end;
    v_amt_to := case when p_changes ? 'value' then p_changes -> 'value' -> 'to' else to_jsonb(p_deal_value) end;
    f := f || jsonb_build_object('values.value', jsonb_build_object(
      'from', case when jsonb_typeof(v_amt_from) = 'number' then jsonb_build_object('amount', v_amt_from, 'currency', v_cur_from) else 'null'::jsonb end,
      'to', case when jsonb_typeof(v_amt_to) = 'number' then jsonb_build_object('amount', v_amt_to, 'currency', v_cur_to) else 'null'::jsonb end));
  end if;
  if f = '{}'::jsonb then
    return null;
  end if;
  return jsonb_build_array(jsonb_build_object('op', 'update_row', 'row_id', p_deal_id, 'fields', f));
end;
$$;

revoke all on function public._deal_event_changes(text, jsonb, uuid, numeric, text, uuid) from public, anon, authenticated;

create or replace function public._deals_to_pipelines()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  p record;
  f record;
  v_owner uuid;
  v_currency text;
  v_default uuid;
  v_key text;
  v_n int;
  v_pos int;
  n_tables int := 0;
  n_columns int := 0;
  n_rows int := 0;
  n_changes int := 0;
  n_events_left_out int := 0;
  n_links int := 0;
  n_activity int := 0;
  n_views int := 0;
  n_mentions int := 0;
  n_fields_retargeted int := 0;
  n_fields_gone int := 0;
  v_rows int;
begin
  if to_regclass('public.deal') is null then
    return jsonb_build_object('skipped', 'the deal tables are gone');
  end if;
  -- An import: no 'created' line per row (521); a definition's target may
  -- change here (524's guard).
  perform set_config('dial8.data_source', 'import', true);
  perform set_config('dial8.field_definition_write', 'on', true);

  -- Stage names, one per stage, unique within its pipeline.
  drop table if exists pg_temp._d2p_stage;
  create temp table _d2p_stage on commit drop as
    select s.id, s.pipeline_id, s.workspace_id, s.kind, s.position,
           case when row_number() over w > 1 then left(btrim(s.name), 54) || ' (' || row_number() over w || ')' else btrim(s.name) end as name
      from public.deal_stage s
    window w as (partition by s.pipeline_id, lower(btrim(s.name)) order by s.position, s.created_at, s.id);

  -- Each workspace's deal custom field keys, as column keys: a system
  -- column's key (or Notes') takes a suffix.
  drop table if exists pg_temp._d2p_key;
  create temp table _d2p_key (workspace_id uuid, src text, dst text, primary key (workspace_id, src)) on commit drop;
  for f in select * from public.custom_field_definition where entity_type = 'deal' and table_id is null order by workspace_id, position, created_at loop
    v_key := f.key;
    v_n := 2;
    while v_key = any (public.pipeline_system_keys() || array['notes'])
          or exists (select 1 from pg_temp._d2p_key k where k.workspace_id = f.workspace_id and k.dst = v_key) loop
      v_key := left(f.key, 40 - length('_' || v_n)) || '_' || v_n;
      v_n := v_n + 1;
    end loop;
    insert into pg_temp._d2p_key values (f.workspace_id, f.key, v_key);
  end loop;

  for p in select * from public.deal_pipeline order by workspace_id, is_default desc, position, created_at loop
    v_default := coalesce(
      (select d.id from public.deal_pipeline d where d.workspace_id = p.workspace_id and d.is_default),
      (select d.id from public.deal_pipeline d where d.workspace_id = p.workspace_id order by d.position, d.created_at limit 1));

    -- The table.
    if not exists (select 1 from public.data_table t where t.id = p.id) then
      select m.id into v_owner from public.member m
       where m.workspace_id = p.workspace_id and m.role <> 'guest'
       order by (m.role = 'owner') desc, (m.role = 'admin') desc, m.created_at
       limit 1;
      insert into public.data_table (id, workspace_id, name, kind, is_default, owner_member_id, visibility, version, position, created_at, updated_at)
      values (p.id, p.workspace_id, left(btrim(p.name), 200), 'pipeline',
              p.is_default and not exists (select 1 from public.data_table t where t.workspace_id = p.workspace_id and t.is_default),
              v_owner, 'workspace', 0,
              coalesce((select max(t.position) + 1 from public.data_table t where t.workspace_id = p.workspace_id), 0),
              p.created_at, p.updated_at);
      n_tables := n_tables + 1;
    end if;

    -- Its columns: the system ones, Notes, then the deal fields.
    select coalesce(mode() within group (order by d.currency), 'USD') into v_currency from public.deal d where d.pipeline_id = p.id;
    insert into public.custom_field_definition (workspace_id, entity_type, table_id, key, label, field_type, options, config, position, system, created_at)
    select p.workspace_id, 'data_row', p.id, c.key, c.label, c.field_type, c.options, c.config, c.pos, c.system, p.created_at
      from (values
        ('stage', 'Stage', 'select',
          coalesce((select array_agg(s.name order by s.position, s.name) from pg_temp._d2p_stage s where s.pipeline_id = p.id), '{}'),
          jsonb_build_object('outcomes', coalesce((select jsonb_object_agg(s.name, s.kind) from pg_temp._d2p_stage s where s.pipeline_id = p.id and s.kind in ('won', 'lost')), '{}'::jsonb)),
          0, true),
        ('value', 'Value', 'currency', '{}'::text[], jsonb_build_object('currency', v_currency), 1, true),
        ('company', 'Company', 'relation', '{}'::text[], '{"target": {"kind": "company"}, "multiple": false}'::jsonb, 2, true),
        ('contacts', 'Contacts', 'relation', '{}'::text[], '{"target": {"kind": "contact"}, "multiple": true}'::jsonb, 3, true),
        ('expected_close', 'Expected close', 'date', '{}'::text[], '{}'::jsonb, 4, true),
        ('owner', 'Owner', 'person', '{}'::text[], '{}'::jsonb, 5, true),
        ('notes', 'Notes', 'text', '{}'::text[], '{}'::jsonb, 6, false)
      ) c(key, label, field_type, options, config, pos, system)
    on conflict (workspace_id, entity_type, table_id, key) do nothing;
    get diagnostics v_rows = row_count;
    n_columns := n_columns + v_rows;

    v_pos := 7;
    for f in
      select d.*, k.dst from public.custom_field_definition d
        join pg_temp._d2p_key k on k.workspace_id = d.workspace_id and k.src = d.key
       where d.workspace_id = p.workspace_id and d.entity_type = 'deal' and d.table_id is null
       order by d.position, d.created_at
    loop
      insert into public.custom_field_definition (workspace_id, entity_type, table_id, key, label, field_type, options, config, position, created_at)
      values (p.workspace_id, 'data_row', p.id, f.dst, f.label, f.field_type, f.options,
              case when f.config -> 'target' ->> 'kind' = 'deal'
                then jsonb_set(f.config, '{target}', jsonb_build_object('kind', 'data_row', 'table_id', v_default))
                else f.config end,
              v_pos, f.created_at)
      on conflict (workspace_id, entity_type, table_id, key) do nothing;
      get diagnostics v_rows = row_count;
      n_columns := n_columns + v_rows;
      v_pos := v_pos + 1;
    end loop;

    -- Its first change: the table and its columns, as create_data_table logs them.
    insert into public.data_change (id, workspace_id, table_id, version, source, reason, changes, created_at)
    select md5('deals_to_pipelines:' || p.id::text)::uuid, p.workspace_id, p.id, 1, 'import', 'Moved from Deals',
           jsonb_build_array(jsonb_build_object('op', 'create_table')) || coalesce((
             select jsonb_agg(jsonb_build_object('op', 'create_column', 'key', c.key, 'column_id', c.id, 'label', c.label,
                      'field_type', c.field_type, 'options', to_jsonb(c.options), 'config', c.config) order by c.position)
               from public.custom_field_definition c where c.table_id = p.id), '[]'::jsonb),
           p.created_at
    on conflict (id) do nothing;

    -- The rows. A relation value that links deals waits for the second pass:
    -- the rows it links may not be there yet.
    insert into public.data_row (id, workspace_id, table_id, title, custom_fields, position, created_by_user_id, created_at, updated_at, stage_changed_at, closed_at)
    select d.id, d.workspace_id, p.id, left(btrim(d.name), 2000),
           jsonb_strip_nulls(jsonb_build_object(
             'stage', (select to_jsonb(s.name) from pg_temp._d2p_stage s where s.id = d.stage_id),
             'value', case when d.value is not null then jsonb_build_object('amount', d.value, 'currency', d.currency) end,
             'company', case when exists (select 1 from public.company co where co.id = d.company_id and co.workspace_id = d.workspace_id)
                          then jsonb_build_array(d.company_id) end,
             'contacts', (select jsonb_agg(z.c order by z.o) from (
                            select distinct on (u.c) u.c, u.o from unnest(d.contact_ids) with ordinality u(c, o)
                             where exists (select 1 from public.contact ct where ct.id = u.c and ct.workspace_id = d.workspace_id)
                             order by u.c, u.o) z),
             'expected_close', to_char(d.expected_close_date, 'YYYY-MM-DD'),
             'owner', case when exists (select 1 from public.member m where m.id = d.owner_id and m.workspace_id = d.workspace_id) then to_jsonb(d.owner_id) end,
             'notes', case when btrim(coalesce(d.notes, '')) <> '' then to_jsonb(left(d.notes, 2000)) end))
           || coalesce((
             select jsonb_object_agg(k.dst, d.custom_fields -> k.src)
               from pg_temp._d2p_key k
               join public.custom_field_definition fd on fd.workspace_id = k.workspace_id and fd.entity_type = 'deal' and fd.table_id is null and fd.key = k.src
              where k.workspace_id = d.workspace_id
                and d.custom_fields ? k.src
                and jsonb_typeof(d.custom_fields -> k.src) <> 'null'
                and not (fd.field_type = 'relation' and fd.config -> 'target' ->> 'kind' = 'deal')), '{}'::jsonb),
           (row_number() over (order by d.created_at, d.id))::numeric
             + coalesce((select max(r.position) from public.data_row r where r.table_id = p.id), 0),
           d.created_by_user_id, d.created_at, d.updated_at, d.stage_changed_at, d.closed_at
      from public.deal d
     where d.pipeline_id = p.id
       and not exists (select 1 from public.data_row r where r.id = d.id)
    on conflict (id) do nothing;
    get diagnostics v_rows = row_count;
    n_rows := n_rows + v_rows;
  end loop;

  -- The second pass: relation values that link deals, to the rows now there.
  for f in
    select fd.workspace_id, fd.key as src, k.dst
      from public.custom_field_definition fd
      join pg_temp._d2p_key k on k.workspace_id = fd.workspace_id and k.src = fd.key
     where fd.entity_type = 'deal' and fd.table_id is null and fd.field_type = 'relation' and fd.config -> 'target' ->> 'kind' = 'deal'
  loop
    update public.data_row r
       set custom_fields = r.custom_fields || jsonb_build_object(f.dst, z.ids)
      from (
        select d.id, jsonb_agg(x order by o) as ids
          from public.deal d
          cross join lateral jsonb_array_elements_text(d.custom_fields -> f.src) with ordinality e(x, o)
         where d.workspace_id = f.workspace_id
           and jsonb_typeof(d.custom_fields -> f.src) = 'array'
           and exists (select 1 from public.data_row t join public.data_table tt on tt.id = t.table_id
                        where t.id::text = x and tt.workspace_id = f.workspace_id and tt.is_default)
         group by d.id
      ) z
     where r.id = z.id and not (r.custom_fields ? f.dst);
  end loop;

  -- The changes: after each table's first, in the order they happened.
  with ev as (
    select e.*, d.pipeline_id as table_id, d.value as deal_value, d.currency as deal_currency,
           public._deal_event_changes(e.kind, e.changes, e.deal_id, d.value, d.currency, d.workspace_id) as entries
      from public.deal_event e
      join public.deal d on d.id = e.deal_id
  ), kept as (
    select ev.*, row_number() over (partition by ev.table_id order by ev.created_at, ev.id) + 1 as version
      from ev where ev.entries is not null
  )
  insert into public.data_change (id, workspace_id, table_id, version, actor_user_id, actor_member_id, source, reason, changes, undo_of, undone_at, created_at)
  select k.id, k.workspace_id, k.table_id, k.version, k.actor_user_id,
         (select m.id from public.member m where m.user_id = k.actor_user_id and m.workspace_id = k.workspace_id),
         k.source, k.reason, k.entries,
         case when k.kind = 'undo' and k.source_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   and exists (select 1 from kept u where u.id = k.source_ref::uuid and u.table_id = k.table_id and u.kind <> 'undo')
              then k.source_ref::uuid end,
         k.undone_at, k.created_at
    from kept k
   where exists (select 1 from public.data_table t where t.id = k.table_id)
  on conflict (id) do nothing;
  get diagnostics n_changes = row_count;
  select count(*) into n_events_left_out
    from public.deal_event e join public.deal d on d.id = e.deal_id
   where public._deal_event_changes(e.kind, e.changes, e.deal_id, d.value, d.currency, d.workspace_id) is null;

  update public.data_table t
     set version = greatest(t.version, (select max(c.version) from public.data_change c where c.table_id = t.id))
   where t.kind = 'pipeline' and exists (select 1 from public.data_change c where c.table_id = t.id and c.version > t.version);

  -- A relation elsewhere that linked deals links the default pipeline's rows
  -- (524 re-syncs its edges).
  update public.custom_field_definition cf
     set config = jsonb_set(cf.config, '{target}', jsonb_build_object('kind', 'data_row', 'table_id',
           (select t.id from public.data_table t where t.workspace_id = cf.workspace_id and t.is_default)))
   where cf.entity_type <> 'deal'
     and cf.config -> 'target' ->> 'kind' = 'deal'
     and exists (select 1 from public.data_table t where t.workspace_id = cf.workspace_id and t.is_default);
  get diagnostics n_fields_retargeted = row_count;

  -- Edges from and to a deal are the row's.
  delete from public.entity_link l
   where (l.source_type = 'deal' or l.target_type = 'deal')
     and exists (select 1 from public.entity_link x
                  where x.workspace_id = l.workspace_id
                    and x.source_type = case when l.source_type = 'deal' then 'data_row' else l.source_type end
                    and x.source_id = l.source_id
                    and x.target_type = case when l.target_type = 'deal' then 'data_row' else l.target_type end
                    and x.target_id = l.target_id
                    and x.relation = l.relation);
  update public.entity_link
     set source_type = case when source_type = 'deal' then 'data_row' else source_type end,
         target_type = case when target_type = 'deal' then 'data_row' else target_type end
   where source_type = 'deal' or target_type = 'deal';
  get diagnostics n_links = row_count;

  -- The links the move made (a row's company and contacts) are not news:
  -- their 'linked' lines go, as a deal's company and contacts had none.
  delete from public.entity_activity a
   where a.action = 'linked'
     and a.detail ->> 'relation' = 'field_link'
     and a.created_at = now()
     and ((a.entity_type = 'data_row' and exists (select 1 from public.deal d where d.id = a.entity_id))
       or (a.detail ->> 'other_type' = 'data_row' and exists (select 1 from public.deal d where d.id::text = a.detail ->> 'other_id')));

  -- The history: a deal's lines are the row's.
  update public.entity_activity a
     set entity_type = 'data_row',
         detail = case when a.action = 'status_changed' then jsonb_build_object(
                    'from', (select to_jsonb(s.name) from pg_temp._d2p_stage s where s.id::text = a.detail ->> 'from'),
                    'to', (select to_jsonb(s.name) from pg_temp._d2p_stage s where s.id::text = a.detail ->> 'to'))
                  else a.detail end
   where a.entity_type = 'deal';
  get diagnostics n_activity = row_count;
  update public.entity_activity a
     set detail = a.detail
       || case when a.detail ->> 'source_type' = 'deal' then '{"source_type": "data_row"}'::jsonb else '{}'::jsonb end
       || case when a.detail ->> 'other_type' = 'deal' then '{"other_type": "data_row"}'::jsonb else '{}'::jsonb end
   where a.detail ->> 'source_type' = 'deal' or a.detail ->> 'other_type' = 'deal';

  -- Views of deals: of the default pipeline's rows.
  update public.view v
     set entity_type = 'data_row',
         scope_type = 'data_table',
         scope_id = (select t.id from public.data_table t where t.workspace_id = v.workspace_id and t.is_default),
         filters = '[]'::jsonb,
         ordering = '[]'::jsonb,
         grouping = case when v.layout::text = 'board' then '{"field": "custom_fields.stage", "direction": "asc"}'::jsonb end,
         sub_grouping = null,
         display_properties = null,
         board_group_by = null
   where v.entity_type::text = 'deal'
     and exists (select 1 from public.data_table t where t.workspace_id = v.workspace_id and t.is_default);
  get diagnostics n_views = row_count;

  -- Team chat mentions.
  select count(*) into n_mentions from public.team_chat_message where record_mentions @> '[{"type": "deal"}]'::jsonb;
  if n_mentions > 0 then
    -- 480's guard would stamp them edited: they are not.
    alter table public.team_chat_message disable trigger team_chat_message_guard;
    update public.team_chat_message m
       set record_mentions = (
         select jsonb_agg(case when e ->> 'type' = 'deal' then e || '{"type": "data_row"}'::jsonb else e end order by o)
           from jsonb_array_elements(m.record_mentions) with ordinality x(e, o))
     where m.record_mentions @> '[{"type": "deal"}]'::jsonb;
    alter table public.team_chat_message enable trigger team_chat_message_guard;
  end if;

  -- The deal fields are the pipelines' columns now.
  delete from public.custom_field_definition where entity_type = 'deal';
  get diagnostics n_fields_gone = row_count;

  return jsonb_build_object(
    'tables', n_tables, 'columns', n_columns, 'rows', n_rows, 'changes', n_changes,
    'events_left_out', n_events_left_out, 'links', n_links, 'activity', n_activity,
    'views', n_views, 'mentions', n_mentions, 'fields_retargeted', n_fields_retargeted,
    'deal_fields_gone', n_fields_gone);
end;
$$;

revoke all on function public._deals_to_pipelines() from public, anon, authenticated;

select public._deals_to_pipelines() as moved;
