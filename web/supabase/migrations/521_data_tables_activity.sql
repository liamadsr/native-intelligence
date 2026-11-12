-- ============================================================
-- 521: the activity log records tables and their rows (Tables, phase 1).
-- ============================================================
-- data_table and data_row are `activity` kinds in the entity registry
-- (src/lib/knowledge/entity-registry.ts), so the log (488, 489, 497) gains
-- their triggers, written by 489's rules: a statement-level AFTER INSERT over
-- the transition table, a row-level AFTER UPDATE OF … with a WHEN clause, no
-- subtransaction, SECURITY DEFINER with a pinned search_path, a write only
-- when entity_activity_writable, the actor from entity_activity_actor, a
-- move of workspace carrying the record's history (entity_activity_follow).
--
--   data_table  created; renamed (name); archived / restored (archived_at)
--   data_row    created; renamed (title); archived / restored (archived_at);
--               updated (its values: 497's function, keys only)
-- A row an import made logs no 'created' (apply_data_ops sets
-- dial8.data_source for its transaction, 520): an import is a thousand rows
-- nobody needs a line for each of, as 488 leaves out contacts an import made.
-- Nor do a new table's first rows (create_data_table sets
-- dial8.data_new_table): the table's own 'created' says it.
--
-- The read policy (489) probes the kinds with a per-record rule through their
-- own table, under the reader's RLS. A table may be private, and a row is
-- its table's, so both join the probed list, for the record and for the one
-- a row's detail names. The edge trigger's kinds (489) gain both, so a
-- mention of a row, or a link to one, lands in its History.
--
-- After 489, 497 and 520. Idempotent (create or replace, drop … if exists).
-- No backslashes anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- ── Tables ──────────────────────────────────────────────────────────────────
create or replace function public.entity_activity_data_table_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
begin
  select * into a from public.entity_activity_actor();
  insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id)
  select n.workspace_id, 'data_table', n.id, 'created', a.actor_kind, m.id
    from new_rows n
    left join public.member m on m.user_id = a.actor_user_id and m.workspace_id = n.workspace_id
   where public.entity_activity_writable(n.workspace_id);
  return null;
end;
$$;

create or replace function public.entity_activity_data_table_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
begin
  if old.workspace_id is distinct from new.workspace_id then
    perform public.entity_activity_follow('data_table', new.id, old.workspace_id, new.workspace_id);
    return null;
  end if;
  if not public.entity_activity_writable(new.workspace_id) then
    return null;
  end if;
  select * into a from public.entity_activity_actor();
  insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, detail)
  select new.workspace_id, 'data_table', new.id, v.action, a.actor_kind,
         public.entity_activity_member(a.actor_user_id, new.workspace_id), v.detail
    from (values
      ('renamed', '{}'::jsonb, old.name is distinct from new.name),
      ('archived', '{}'::jsonb, new.archived_at is not null and old.archived_at is null),
      ('restored', '{}'::jsonb, old.archived_at is not null and new.archived_at is null)
    ) v(action, detail, hit)
   where v.hit;
  return null;
end;
$$;

revoke all on function public.entity_activity_data_table_insert() from public, anon, authenticated;
revoke all on function public.entity_activity_data_table_update() from public, anon, authenticated;

drop trigger if exists entity_activity_insert on public.data_table;
create trigger entity_activity_insert
  after insert on public.data_table
  referencing new table as new_rows
  for each statement execute function public.entity_activity_data_table_insert();

drop trigger if exists entity_activity_update on public.data_table;
create trigger entity_activity_update
  after update of name, archived_at, workspace_id on public.data_table
  for each row
  when (old.name is distinct from new.name
     or old.archived_at is distinct from new.archived_at
     or old.workspace_id is distinct from new.workspace_id)
  execute function public.entity_activity_data_table_update();

-- ── Rows ────────────────────────────────────────────────────────────────────
create or replace function public.entity_activity_data_row_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
begin
  -- An import's rows are one batch in the table's own history (data_change).
  if coalesce(current_setting('dial8.data_source', true), '') = 'import' then
    return null;
  end if;
  select * into a from public.entity_activity_actor();
  insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id)
  select n.workspace_id, 'data_row', n.id, 'created', a.actor_kind, m.id
    from new_rows n
    left join public.member m on m.user_id = a.actor_user_id and m.workspace_id = n.workspace_id
   where public.entity_activity_writable(n.workspace_id)
     and n.table_id::text is distinct from nullif(current_setting('dial8.data_new_table', true), '');
  return null;
end;
$$;

create or replace function public.entity_activity_data_row_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
begin
  if old.workspace_id is distinct from new.workspace_id then
    perform public.entity_activity_follow('data_row', new.id, old.workspace_id, new.workspace_id);
    return null;
  end if;
  if not public.entity_activity_writable(new.workspace_id) then
    return null;
  end if;
  select * into a from public.entity_activity_actor();
  insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, detail)
  select new.workspace_id, 'data_row', new.id, v.action, a.actor_kind,
         public.entity_activity_member(a.actor_user_id, new.workspace_id), v.detail
    from (values
      ('renamed', '{}'::jsonb, old.title is distinct from new.title),
      ('archived', '{}'::jsonb, new.archived_at is not null and old.archived_at is null),
      ('restored', '{}'::jsonb, old.archived_at is not null and new.archived_at is null)
    ) v(action, detail, hit)
   where v.hit;
  return null;
end;
$$;

revoke all on function public.entity_activity_data_row_insert() from public, anon, authenticated;
revoke all on function public.entity_activity_data_row_update() from public, anon, authenticated;

drop trigger if exists entity_activity_insert on public.data_row;
create trigger entity_activity_insert
  after insert on public.data_row
  referencing new table as new_rows
  for each statement execute function public.entity_activity_data_row_insert();

drop trigger if exists entity_activity_update on public.data_row;
create trigger entity_activity_update
  after update of title, archived_at, workspace_id on public.data_row
  for each row
  when (old.title is distinct from new.title
     or old.archived_at is distinct from new.archived_at
     or old.workspace_id is distinct from new.workspace_id)
  execute function public.entity_activity_data_row_update();

-- A row's values: 497's one function, keys only.
drop trigger if exists entity_activity_custom_fields on public.data_row;
create trigger entity_activity_custom_fields
  after update of custom_fields on public.data_row
  for each row
  when (old.custom_fields is distinct from new.custom_fields)
  execute function public.entity_activity_custom_fields_update('data_row');

-- ── Edges: 489's function, with the two kinds in its list ───────────────────
create or replace function public.entity_activity_entity_link_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
  kinds text[] := array['action', 'document', 'capture', 'project', 'initiative', 'contact', 'company', 'deal', 'flow', 'team_chat_message', 'data_table', 'data_row'];
begin
  select * into a from public.entity_activity_actor();
  insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, subject_member_id, detail)
  select n.workspace_id, v.entity_type, v.entity_id, v.action,
         case when a.actor_kind = 'system' and n.created_by is not null then 'member' else a.actor_kind end,
         case when a.actor_kind = 'system' then n.created_by else m.id end,
         v.subject, v.detail
    from new_rows n
    left join public.member m on m.user_id = a.actor_user_id and m.workspace_id = n.workspace_id
    cross join lateral (values
      ('mentioned', n.target_type, n.target_id, null::uuid,
        jsonb_build_object('source_type', n.source_type, 'source_id', n.source_id),
        n.relation = 'mentions' and n.target_type = any(kinds)),
      ('mentioned', n.source_type, n.source_id, n.target_id,
        jsonb_build_object('source_type', n.source_type, 'source_id', n.source_id),
        n.relation = 'mentions' and n.target_type = 'member' and n.source_type = any(kinds)),
      ('linked', n.target_type, n.target_id, null::uuid,
        jsonb_build_object('other_type', n.source_type, 'other_id', n.source_id, 'relation', n.relation),
        n.relation <> 'mentions' and n.target_type = any(kinds) and n.source_type = any(kinds)),
      ('linked', n.source_type, n.source_id, null::uuid,
        jsonb_build_object('other_type', n.target_type, 'other_id', n.target_id, 'relation', n.relation),
        n.relation <> 'mentions' and n.target_type = any(kinds) and n.source_type = any(kinds))
    ) v(action, entity_type, entity_id, subject, detail, hit)
   where v.hit
     and n.source_type <> 'claim'
     and v.entity_id is not null
     and public.entity_activity_writable(n.workspace_id);
  return null;
end;
$$;

revoke all on function public.entity_activity_entity_link_insert() from public, anon, authenticated;

-- ── Reading follows the record: 489's policy, with the two kinds probed ─────
drop policy if exists entity_activity_member_select on public.entity_activity;
create policy entity_activity_member_select on public.entity_activity
  for select using (
    public.is_workspace_member(workspace_id)
    and case entity_type
      when 'document' then exists (select 1 from public.document x where x.id = entity_activity.entity_id offset 0)
      when 'capture' then exists (select 1 from public.captures x where x.id = entity_activity.entity_id offset 0)
      when 'contact' then exists (select 1 from public.contact x where x.id = entity_activity.entity_id offset 0)
      when 'company' then exists (select 1 from public.company x where x.id = entity_activity.entity_id offset 0)
      when 'team_chat_message' then exists (select 1 from public.team_chat_message x where x.id = entity_activity.entity_id offset 0)
      when 'data_table' then exists (select 1 from public.data_table x where x.id = entity_activity.entity_id offset 0)
      when 'data_row' then exists (select 1 from public.data_row x where x.id = entity_activity.entity_id offset 0)
      when 'action' then true
      when 'project' then true
      when 'initiative' then true
      when 'deal' then true
      when 'flow' then true
      else false
    end
    and case
      when action not in ('mentioned', 'linked') then true
      when coalesce(detail ->> 'source_type', detail ->> 'other_type') is null then true
      when detail ->> 'source_type' = entity_type and detail ->> 'source_id' = entity_id::text then true
      when coalesce(detail ->> 'source_type', detail ->> 'other_type') in ('action', 'project', 'initiative', 'deal', 'flow') then true
      when not pg_catalog.pg_input_is_valid(coalesce(detail ->> 'source_id', detail ->> 'other_id', ''), 'uuid') then false
      when coalesce(detail ->> 'source_type', detail ->> 'other_type') = 'document'
        then exists (select 1 from public.document x where x.id = coalesce(detail ->> 'source_id', detail ->> 'other_id')::uuid offset 0)
      when coalesce(detail ->> 'source_type', detail ->> 'other_type') = 'capture'
        then exists (select 1 from public.captures x where x.id = coalesce(detail ->> 'source_id', detail ->> 'other_id')::uuid offset 0)
      when coalesce(detail ->> 'source_type', detail ->> 'other_type') = 'contact'
        then exists (select 1 from public.contact x where x.id = coalesce(detail ->> 'source_id', detail ->> 'other_id')::uuid offset 0)
      when coalesce(detail ->> 'source_type', detail ->> 'other_type') = 'company'
        then exists (select 1 from public.company x where x.id = coalesce(detail ->> 'source_id', detail ->> 'other_id')::uuid offset 0)
      when coalesce(detail ->> 'source_type', detail ->> 'other_type') = 'team_chat_message'
        then exists (select 1 from public.team_chat_message x where x.id = coalesce(detail ->> 'source_id', detail ->> 'other_id')::uuid offset 0)
      when coalesce(detail ->> 'source_type', detail ->> 'other_type') = 'data_table'
        then exists (select 1 from public.data_table x where x.id = coalesce(detail ->> 'source_id', detail ->> 'other_id')::uuid offset 0)
      when coalesce(detail ->> 'source_type', detail ->> 'other_type') = 'data_row'
        then exists (select 1 from public.data_row x where x.id = coalesce(detail ->> 'source_id', detail ->> 'other_id')::uuid offset 0)
      else false
    end
  );
