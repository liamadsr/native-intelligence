-- ============================================================
-- 549: the old deal tables go (Tables, phase 7).
-- ============================================================
-- Every deal is a pipeline's row since 548, so 473's deal tables, and what
-- kept them, go: deal_event, deal, deal_stage, deal_pipeline;
-- ensure_default_deal_pipeline (540's ensure_default_pipeline instead), the
-- deal triggers and their functions (473's write check and contact clean-up,
-- 488/489's activity lines, 473's contact-merge pair, which 541 replaced),
-- and 548's one-off functions. Dropping them, not keeping them read-only:
-- with nothing left to read, a second copy of the deals would only drift
-- (no backward compatibility to keep, 2026-11).
--
-- Restated without the deal tables, each otherwise its newest definition:
--   _wsmerge_deals            528's: pipelines (540) fold by name, the
--                             default into the default. A source pipeline
--                             with a counterpart gives it its rows, the
--                             stages and columns it lacks (a column of the
--                             same key and another type moves under a key of
--                             its own) and its views, and goes, with its own
--                             change log: the rows' earlier changes don't
--                             come with them. One with no counterpart moves
--                             whole with the generic re-stamp. The kinds'
--                             fields fold as before; 528's value rewrite
--                             runs last, as before.
--   workspace_integrity_sweep 473's, checking a pipeline's rows in place of
--                             the deals.
--   _relation_target_ok,
--   _custom_field_table       524's, without 'deal'.
--   _field_config_ok          540's, without 'deal' as a relation's kind, and
--                             with phase 6's formula and rollup settings
--                             (531, built beside this one): the newest
--                             definition carries both.
--   custom_field_definition_entity_check   520's list without 'deal'.
--   entity_activity_backfill_home          516's without 'deal'; the
--                             backfill's 'deal' source goes (it was done).
--   entity_activity_backfill_step          516's without its deal branch,
--                             its 'deal' kind and its deal table check.
--
-- Left as they are: view_entity_type keeps its 'deal' value (an enum value
-- can't be dropped; no view uses it after 548), and the activity read
-- policy's and kind lists' 'deal' words, which name no table.
--
-- After 540 to 548. Re-runnable. No backslashes anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. The deal triggers and functions
-- ------------------------------------------------------------

drop trigger if exists contact_merge_move_deals on public.contact_merge;
drop trigger if exists contact_unmerge_restore_deals on public.contact_merge;
drop trigger if exists deal_forget_contact on public.contact;
drop function if exists public.contact_merge_move_deals();
drop function if exists public.contact_unmerge_restore_deals();
drop function if exists public.deal_forget_contact();

-- ------------------------------------------------------------
-- 2. The tables (their own triggers go with them)
-- ------------------------------------------------------------

drop table if exists public.deal_event;
drop table if exists public.deal;
drop table if exists public.deal_stage;
drop table if exists public.deal_pipeline;

drop function if exists public.deal_before_write();
drop function if exists public.ensure_default_deal_pipeline(uuid);
drop function if exists public.entity_activity_deal_insert();
drop function if exists public.entity_activity_deal_update();
drop function if exists public._deals_to_pipelines();
drop function if exists public._deal_event_changes(text, jsonb, uuid, numeric, text, uuid);

-- ------------------------------------------------------------
-- 3. Fields: no 'deal' kind
-- ------------------------------------------------------------

alter table public.custom_field_definition drop constraint if exists custom_field_definition_entity_check;
alter table public.custom_field_definition
  add constraint custom_field_definition_entity_check
  check (entity_type in ('document', 'contact', 'project', 'action', 'initiative', 'company', 'data_row'));

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
      and (p_config -> 'target' ->> 'kind') in ('contact', 'company', 'action', 'project', 'initiative', 'document', 'capture', 'flow', 'data_row')
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

create or replace function public._custom_field_table(p_kind text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_kind
    when 'contact' then 'contact'
    when 'company' then 'company'
    when 'action' then 'actions'
    when 'project' then 'projects'
    when 'initiative' then 'initiative'
    when 'document' then 'document'
    when 'data_row' then 'data_row'
  end;
$$;
revoke all on function public._custom_field_table(text) from public, anon, authenticated;

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
revoke all on function public._relation_target_ok(text, uuid, uuid, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 4. The activity backfill: no deals
-- ------------------------------------------------------------

delete from public.entity_activity_backfill_progress where source = 'deal';

create or replace function public.entity_activity_backfill_home(p_type text, p_id uuid)
returns uuid
language sql
volatile
set search_path = public, pg_temp
as $$
  select case p_type
    when 'action' then (select x.workspace_id from public.actions x where x.id = p_id for share)
    when 'document' then (select x.workspace_id from public.document x where x.id = p_id for share)
    when 'capture' then (select x.workspace_id from public.captures x where x.id = p_id and x.is_eval is not true for share)
    when 'project' then (select x.workspace_id from public.projects x where x.id = p_id for share)
    when 'initiative' then (select x.workspace_id from public.initiative x where x.id = p_id for share)
    when 'contact' then (select x.workspace_id from public.contact x where x.id = p_id and x.merged_into_contact_id is null for share)
    when 'company' then (select x.workspace_id from public.company x where x.id = p_id for share)
    when 'flow' then (select x.workspace_id from public.flow x where x.id = p_id for share)
    when 'team_chat_message' then (select x.workspace_id from public.team_chat_message x where x.id = p_id and x.deleted_at is null for share)
  end;
$$;
revoke all on function public.entity_activity_backfill_home(text, uuid) from public, anon, authenticated;

-- 516's entity_activity_backfill_step, without deals: no 'deal' source, no
-- branch reading public.deal, and the catalog check names no deal table (a
-- database replayed from scratch has none after this file).
create or replace function public.entity_activity_backfill_step(p_limit integer default 1000)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  p record;
  v_after uuid;
  v_last uuid;
  v_seen integer := 0;
  v_rows integer := 0;
  v_ids uuid[];
  v_rows_held numeric;
  kinds constant text[] := array['action', 'document', 'capture', 'project', 'initiative', 'contact', 'company', 'flow', 'team_chat_message'];
begin
  if p_limit is null or p_limit < 1 or p_limit > 10000 then
    raise exception 'entity_activity_backfill_step: p_limit must be between 1 and 10000' using errcode = '22023';
  end if;
  -- A batch never waits long on someone's open edit: the next tick retries.
  perform set_config('lock_timeout', '2s', true);

  if exists (select 1 from public.workspace_merge_job j where j.status = 'queued') then
    return jsonb_build_object('waiting', 'merge');
  end if;

  select * into p
    from public.entity_activity_backfill_progress
   where done_at is null
   order by ord
   limit 1
   for update skip locked;
  if not found then
    if exists (select 1 from public.entity_activity_backfill_progress where done_at is null) then
      return jsonb_build_object('busy', true);
    end if;
    return jsonb_build_object('finished', true);
  end if;
  v_after := coalesce(p.after_id, '00000000-0000-0000-0000-000000000000'::uuid);

  -- ── Tasks: created; a finished one's state ────────────────────────────────
  if p.source = 'action' then
    select coalesce(array_agg(s.id order by s.id), '{}') into v_ids
      from (select x.id from public.actions x
             where x.id > v_after
               and x.confirmation is distinct from 'suggested'
             order by x.id
             limit p_limit
               for share of x) s;
    with b as (
      select x.id, x.workspace_id, x.user_id, x.created_at, x.completed_at, x.status_id,
             -- Made by an agent: from a chat, a meeting's extraction or a chat suggestion.
             coalesce(x.source_type in ('chat_suggestion', 'meeting_extraction') or x.context_source in ('ai_chat', 'meeting_note'), false) as by_agent
        from public.actions x
       where x.id = any(v_ids)
    ), ins as (
      insert into public.entity_activity (id, workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, detail, created_at, backfilled)
      select public.entity_activity_backfill_id('action', b.id::text, v.action), b.workspace_id, 'action', b.id, v.action,
             case when v.action <> 'created' or m.id is null then 'system' when b.by_agent then 'agent' else 'member' end, case when v.action = 'created' then m.id end, v.detail, v.at, true
        from b
        left join public.member m on m.user_id = b.user_id and m.workspace_id = b.workspace_id
        cross join lateral (values
          ('created', '{}'::jsonb, b.created_at, array['created'], true),
          ('status_changed', jsonb_build_object('from', null, 'to', b.status_id), greatest(b.completed_at, b.created_at), array['status_changed'],
            b.completed_at is not null
            and exists (select 1 from public.workflow_state s where s.id = b.status_id and s.category::text in ('completed', 'canceled')))
        ) v(action, detail, at, logged, hit)
       where v.hit
         and public.entity_activity_writable(b.workspace_id)
         and not exists (select 1 from public.entity_activity e where e.entity_type = 'action' and e.entity_id = b.id and e.action = any(v.logged))
      on conflict (id) do nothing
      returning 1
    )
    select count(*)::int into v_rows from ins;

  -- ── Documents: created; archived ──────────────────────────────────────────
  elsif p.source = 'document' then
    select coalesce(array_agg(s.id order by s.id), '{}') into v_ids
      from (select x.id from public.document x
             where x.id > v_after
             order by x.id
             limit p_limit
               for share of x) s;
    with b as (
      select x.id, x.workspace_id, x.created_by, x.created_at, x.updated_at, x.status
        from public.document x
       where x.id = any(v_ids)
    ), ins as (
      insert into public.entity_activity (id, workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, detail, created_at, backfilled)
      select public.entity_activity_backfill_id('document', b.id::text, v.action), b.workspace_id, 'document', b.id, v.action,
             case when v.action = 'created' and m.id is not null then 'member' else 'system' end, case when v.action = 'created' then m.id end, '{}'::jsonb, v.at, true
        from b
        left join public.member m on m.id = b.created_by and m.workspace_id = b.workspace_id
        cross join lateral (values
          ('created', b.created_at, array['created'], true),
          ('archived', greatest(b.updated_at, b.created_at), array['archived', 'restored'], b.status = 'archived')
        ) v(action, at, logged, hit)
       where v.hit
         and public.entity_activity_writable(b.workspace_id)
         and not exists (select 1 from public.entity_activity e where e.entity_type = 'document' and e.entity_id = b.id and e.action = any(v.logged))
      on conflict (id) do nothing
      returning 1
    )
    select count(*)::int into v_rows from ins;

  -- ── Captures: created; archived (never an evaluation capture) ─────────────
  elsif p.source = 'capture' then
    select coalesce(array_agg(s.id order by s.id), '{}') into v_ids
      from (select x.id from public.captures x
             where x.id > v_after
               and x.is_eval is not true
             order by x.id
             limit p_limit
               for share of x) s;
    with b as (
      select x.id, x.workspace_id, x.user_id, x.created_at, x.updated_at, x.status
        from public.captures x
       where x.id = any(v_ids)
    ), ins as (
      insert into public.entity_activity (id, workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, detail, created_at, backfilled)
      select public.entity_activity_backfill_id('capture', b.id::text, v.action), b.workspace_id, 'capture', b.id, v.action,
             case when v.action = 'created' and m.id is not null then 'member' else 'system' end, case when v.action = 'created' then m.id end, '{}'::jsonb, v.at, true
        from b
        left join public.member m on m.user_id = b.user_id and m.workspace_id = b.workspace_id
        cross join lateral (values
          ('created', b.created_at, array['created'], true),
          ('archived', greatest(b.updated_at, b.created_at), array['archived', 'restored'], b.status = 'archived')
        ) v(action, at, logged, hit)
       where v.hit
         and public.entity_activity_writable(b.workspace_id)
         and not exists (select 1 from public.entity_activity e where e.entity_type = 'capture' and e.entity_id = b.id and e.action = any(v.logged))
      on conflict (id) do nothing
      returning 1
    )
    select count(*)::int into v_rows from ins;

  -- ── Projects: created; archived ───────────────────────────────────────────
  elsif p.source = 'project' then
    select coalesce(array_agg(s.id order by s.id), '{}') into v_ids
      from (select x.id from public.projects x
             where x.id > v_after
             order by x.id
             limit p_limit
               for share of x) s;
    with b as (
      select x.id, x.workspace_id, x.user_id, x.created_at, x.updated_at, x.is_archived
        from public.projects x
       where x.id = any(v_ids)
    ), ins as (
      insert into public.entity_activity (id, workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, detail, created_at, backfilled)
      select public.entity_activity_backfill_id('project', b.id::text, v.action), b.workspace_id, 'project', b.id, v.action,
             case when v.action = 'created' and m.id is not null then 'member' else 'system' end, case when v.action = 'created' then m.id end, '{}'::jsonb, v.at, true
        from b
        left join public.member m on m.user_id = b.user_id and m.workspace_id = b.workspace_id
        cross join lateral (values
          ('created', b.created_at, array['created'], true),
          ('archived', greatest(b.updated_at, b.created_at), array['archived', 'restored'], b.is_archived is true)
        ) v(action, at, logged, hit)
       where v.hit
         and public.entity_activity_writable(b.workspace_id)
         and not exists (select 1 from public.entity_activity e where e.entity_type = 'project' and e.entity_id = b.id and e.action = any(v.logged))
      on conflict (id) do nothing
      returning 1
    )
    select count(*)::int into v_rows from ins;

  -- ── Initiatives: created; archived (no column names a maker) ──────────────
  elsif p.source = 'initiative' then
    select coalesce(array_agg(s.id order by s.id), '{}') into v_ids
      from (select x.id from public.initiative x
             where x.id > v_after
             order by x.id
             limit p_limit
               for share of x) s;
    with b as (
      select x.id, x.workspace_id, x.created_at, x.updated_at, x.status::text as status
        from public.initiative x
       where x.id = any(v_ids)
    ), ins as (
      insert into public.entity_activity (id, workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, detail, created_at, backfilled)
      select public.entity_activity_backfill_id('initiative', b.id::text, v.action), b.workspace_id, 'initiative', b.id, v.action,
             'system', null, '{}'::jsonb, v.at, true
        from b
        cross join lateral (values
          ('created', b.created_at, array['created'], true),
          ('archived', greatest(b.updated_at, b.created_at), array['archived', 'restored'], b.status = 'archived')
        ) v(action, at, logged, hit)
       where v.hit
         and public.entity_activity_writable(b.workspace_id)
         and not exists (select 1 from public.entity_activity e where e.entity_type = 'initiative' and e.entity_id = b.id and e.action = any(v.logged))
      on conflict (id) do nothing
      returning 1
    )
    select count(*)::int into v_rows from ins;

  -- ── Contacts: created by hand or by an agent (never a sync, an import or a merged one) ──
  elsif p.source = 'contact' then
    select coalesce(array_agg(s.id order by s.id), '{}') into v_ids
      from (select x.id from public.contact x
             where x.id > v_after
               and (x.source is null or x.source = 'manual')
               and x.merged_into_contact_id is null
             order by x.id
             limit p_limit
               for share of x) s;
    with b as (
      select x.id, x.workspace_id, x.created_by_member_id, x.created_at
        from public.contact x
       where x.id = any(v_ids)
    ), ins as (
      insert into public.entity_activity (id, workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, detail, created_at, backfilled)
      select public.entity_activity_backfill_id('contact', b.id::text, 'created'), b.workspace_id, 'contact', b.id, 'created',
             case when m.id is null then 'system' else 'member' end, m.id, '{}'::jsonb, b.created_at, true
        from b
        left join public.member m on m.id = b.created_by_member_id and m.workspace_id = b.workspace_id
       where public.entity_activity_writable(b.workspace_id)
         and not exists (select 1 from public.entity_activity e where e.entity_type = 'contact' and e.entity_id = b.id and e.action = 'created')
      on conflict (id) do nothing
      returning 1
    )
    select count(*)::int into v_rows from ins;

  -- ── Companies: created by hand (never a provider's); no column names a maker ──
  elsif p.source = 'company' then
    select coalesce(array_agg(s.id order by s.id), '{}') into v_ids
      from (select x.id from public.company x
             where x.id > v_after
               and x.source_provider is null
             order by x.id
             limit p_limit
               for share of x) s;
    with b as (
      select x.id, x.workspace_id, x.created_at
        from public.company x
       where x.id = any(v_ids)
    ), ins as (
      insert into public.entity_activity (id, workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, detail, created_at, backfilled)
      select public.entity_activity_backfill_id('company', b.id::text, 'created'), b.workspace_id, 'company', b.id, 'created',
             'system', null, '{}'::jsonb, b.created_at, true
        from b
       where public.entity_activity_writable(b.workspace_id)
         and not exists (select 1 from public.entity_activity e where e.entity_type = 'company' and e.entity_id = b.id and e.action = 'created')
      on conflict (id) do nothing
      returning 1
    )
    select count(*)::int into v_rows from ins;

  -- ── Loops: created ────────────────────────────────────────────────────────
  elsif p.source = 'flow' then
    select coalesce(array_agg(s.id order by s.id), '{}') into v_ids
      from (select x.id from public.flow x
             where x.id > v_after
             order by x.id
             limit p_limit
               for share of x) s;
    with b as (
      select x.id, x.workspace_id, x.created_by, x.created_at
        from public.flow x
       where x.id = any(v_ids)
    ), ins as (
      insert into public.entity_activity (id, workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, detail, created_at, backfilled)
      select public.entity_activity_backfill_id('flow', b.id::text, 'created'), b.workspace_id, 'flow', b.id, 'created',
             case when m.id is null then 'system' else 'member' end, m.id, '{}'::jsonb, b.created_at, true
        from b
        left join public.member m on m.user_id = b.created_by and m.workspace_id = b.workspace_id
       where public.entity_activity_writable(b.workspace_id)
         and not exists (select 1 from public.entity_activity e where e.entity_type = 'flow' and e.entity_id = b.id and e.action = 'created')
      on conflict (id) do nothing
      returning 1
    )
    select count(*)::int into v_rows from ins;

  -- ── Comments: 'commented' on the record, in its workspace now ─────────────
  elsif p.source = 'comment' then
    with b as (
      select c.id, c.commentable_type::text as entity_type, c.commentable_id as entity_id, c.author_id, c.author_user_id, c.created_at
        from public.comment c
       where c.id > v_after
         and c.commentable_id is not null
         and c.commentable_type::text in ('action', 'capture', 'document', 'project', 'contact')
       order by c.id
       limit p_limit
    ), ins as (
      insert into public.entity_activity (id, workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, detail, created_at, backfilled)
      select public.entity_activity_backfill_id('comment', b.id::text), h.workspace_id, b.entity_type, b.entity_id, 'commented',
             case when coalesce(ma.id, mu.id) is null then 'system' else 'member' end, coalesce(ma.id, mu.id),
             jsonb_build_object('comment_id', b.id), b.created_at, true
        from b
        cross join lateral (select public.entity_activity_backfill_home(b.entity_type, b.entity_id) as workspace_id) h
        left join public.member ma on ma.id = b.author_id and ma.workspace_id = h.workspace_id
        left join public.member mu on mu.user_id = b.author_user_id and mu.workspace_id = h.workspace_id
       where public.entity_activity_writable(h.workspace_id)
         and not exists (
           select 1 from public.entity_activity e
            where e.entity_type = b.entity_type and e.entity_id = b.entity_id
              and e.action = 'commented' and e.detail ->> 'comment_id' = b.id::text)
      on conflict (id) do nothing
      returning 1
    )
    select (select b.id from b order by b.id desc limit 1), (select count(*)::int from b), (select count(*)::int from ins)
      into v_last, v_seen, v_rows;

  -- ── Edges: 488's rows, both records in the edge's workspace now ───────────
  elsif p.source = 'entity_link' then
    with b as (
      select l.id, l.workspace_id, l.source_type, l.source_id, l.target_type, l.target_id, l.relation, l.created_by, l.created_at
        from public.entity_link l
       where l.id > v_after
         and l.source_type <> 'claim'
       order by l.id
       limit p_limit
    ), ins as (
      insert into public.entity_activity (id, workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, subject_member_id, detail, created_at, backfilled)
      select public.entity_activity_backfill_id('entity_link', b.id::text, v.action, v.entity_type, v.entity_id::text),
             b.workspace_id, v.entity_type, v.entity_id, v.action,
             case when m.id is null then 'system' else 'member' end, m.id, v.subject, v.detail, b.created_at, true
        from b
        left join public.member m on m.id = b.created_by and m.workspace_id = b.workspace_id
        cross join lateral (values
          -- A record mentioned: on it, the source named.
          ('mentioned', b.target_type, b.target_id, null::uuid, b.source_type, b.source_id,
            jsonb_build_object('source_type', b.source_type, 'source_id', b.source_id),
            b.relation = 'mentions' and b.target_type = any(kinds)),
          -- A member mentioned: on the source, about them.
          ('mentioned', b.source_type, b.source_id, b.target_id, 'member', b.target_id,
            jsonb_build_object('source_type', b.source_type, 'source_id', b.source_id),
            b.relation = 'mentions' and b.target_type = 'member' and b.source_type = any(kinds)),
          -- Linked, on each end.
          ('linked', b.target_type, b.target_id, null::uuid, b.source_type, b.source_id,
            jsonb_build_object('other_type', b.source_type, 'other_id', b.source_id, 'relation', b.relation),
            b.relation <> 'mentions' and b.target_type = any(kinds) and b.source_type = any(kinds)),
          ('linked', b.source_type, b.source_id, null::uuid, b.target_type, b.target_id,
            jsonb_build_object('other_type', b.target_type, 'other_id', b.target_id, 'relation', b.relation),
            b.relation <> 'mentions' and b.target_type = any(kinds) and b.source_type = any(kinds))
        ) v(action, entity_type, entity_id, subject, other_type, other_id, detail, hit)
       where v.hit
         and v.entity_id is not null
         and public.entity_activity_writable(b.workspace_id)
         and public.entity_activity_backfill_home(v.entity_type, v.entity_id) = b.workspace_id
         and case when v.other_type = 'member'
               then exists (select 1 from public.member mm where mm.id = v.other_id and mm.workspace_id = b.workspace_id)
               else public.entity_activity_backfill_home(v.other_type, v.other_id) = b.workspace_id
             end
         and not exists (
           select 1 from public.entity_activity e
            where e.entity_type = v.entity_type and e.entity_id = v.entity_id
              and e.action = v.action and e.detail = v.detail
              and e.subject_member_id is not distinct from v.subject)
      on conflict (id) do nothing
      returning 1
    )
    select (select b.id from b order by b.id desc limit 1), (select count(*)::int from b), (select count(*)::int from ins)
      into v_last, v_seen, v_rows;
  end if;
  -- A record batch: what it locked is what it read.
  if v_ids is not null then
    v_seen := cardinality(v_ids);
    v_last := v_ids[v_seen];
  end if;

  -- The last source done, and nothing ever written, while the sources hold
  -- rows (the catalog's count, which row security cannot hide): the owner
  -- most likely reads through row security. Fail the step (the source stays
  -- open, the tick records the error) instead of calling it done.
  if v_seen < p_limit
     and not exists (select 1 from public.entity_activity_backfill_progress q where q.done_at is null and q.source <> p.source)
     and not exists (select 1 from public.entity_activity e where e.backfilled) then
    select coalesce(sum(greatest(c.reltuples, 0)), 0) into v_rows_held
      from pg_catalog.pg_class c
     -- The kinds whose every row is logged (contacts, companies and edges
     -- may all be synced, imported or claims').
     where c.oid in ('public.document'::regclass, 'public.projects'::regclass, 'public.initiative'::regclass,
                     'public.flow'::regclass);
    if v_rows_held > 0 then
      raise exception 'entity_activity_backfill: every source was read and nothing was written, yet the source tables hold about % rows. Does %, this function''s owner, bypass row security (rolbypassrls) or own those tables?',
        v_rows_held::bigint, current_user using errcode = 'P0001';
    end if;
  end if;

  update public.entity_activity_backfill_progress
     set after_id = coalesce(v_last, after_id),
         seen = seen + v_seen,
         inserted = inserted + v_rows,
         failures = 0,
         last_error = null,
         done_at = case when v_seen < p_limit then now() end,
         updated_at = now()
   where source = p.source;

  return jsonb_build_object('source', p.source, 'seen', v_seen, 'inserted', v_rows, 'done', v_seen < p_limit);
end;
$$;

revoke all on function public.entity_activity_backfill_step(integer) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 5. Workspace merge: pipelines fold by name
-- ------------------------------------------------------------

-- _wsmerge_deals, from 528_field_merge.sql: the pipelines' fold in place of
-- the deal tables'.
CREATE OR REPLACE FUNCTION public._wsmerge_deals(p_source uuid, p_dest uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  p record;
  c record;
  dc record;
  v_dst uuid;
  v_had boolean;
  v_key text;
  v_n int;
  v_pos int;
  v_offset numeric;
  v_rows int;
  n_pipelines int := 0;
  n_rows int := 0;
  n_fields int := 0;
BEGIN
  FOR p IN SELECT * FROM public.data_table WHERE workspace_id = p_source AND kind = 'pipeline' ORDER BY is_default DESC, position LOOP
    SELECT d.id INTO v_dst FROM public.data_table d
      WHERE d.workspace_id = p_dest AND d.kind = 'pipeline' AND ((p.is_default AND d.is_default) OR lower(d.name) = lower(p.name))
      ORDER BY (p.is_default AND d.is_default) DESC, (d.archived_at IS NULL) DESC, d.position
      LIMIT 1;
    IF v_dst IS NULL THEN
      -- No counterpart: it moves whole (the generic re-stamp), and stays the
      -- default only where the destination has none.
      IF p.is_default AND EXISTS (SELECT 1 FROM public.data_table d WHERE d.workspace_id = p_dest AND d.is_default) THEN
        UPDATE public.data_table SET is_default = false WHERE id = p.id;
      END IF;
      CONTINUE;
    END IF;

    -- The stages the destination lacks join its Stage column, with their
    -- outcomes (50 options at most).
    UPDATE public.custom_field_definition d
       SET options = d.options || coalesce((
             SELECT array_agg(u.o ORDER BY u.i) FROM (
               SELECT o, i FROM unnest(s.options) WITH ORDINALITY x(o, i)
                WHERE NOT (o = ANY (d.options)) ORDER BY i LIMIT greatest(0, 50 - cardinality(d.options))) u), '{}'),
           config = jsonb_set(d.config, '{outcomes}', coalesce(d.config -> 'outcomes', '{}'::jsonb) || coalesce((
             SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(coalesce(s.config -> 'outcomes', '{}'::jsonb)) e
              WHERE NOT (e.key = ANY (d.options))), '{}'::jsonb))
      FROM public.custom_field_definition s
     WHERE d.table_id = v_dst AND d.key = 'stage' AND s.table_id = p.id AND s.key = 'stage';

    -- The other columns: one of the same key, type and target folds (a
    -- select's options join); any other moves across, under a key of its
    -- own when the destination has its key.
    FOR c IN SELECT * FROM public.custom_field_definition WHERE table_id = p.id AND key <> 'stage' ORDER BY position LOOP
      SELECT * INTO dc FROM public.custom_field_definition WHERE table_id = v_dst AND key = c.key;
      v_had := FOUND;
      IF v_had AND dc.field_type = c.field_type AND (dc.config -> 'target') IS NOT DISTINCT FROM (c.config -> 'target') THEN
        IF c.field_type IN ('select', 'multi_select') THEN
          UPDATE public.custom_field_definition
             SET options = options || coalesce((
                   SELECT array_agg(u.o ORDER BY u.i) FROM (
                     SELECT o, i FROM unnest(c.options) WITH ORDINALITY x(o, i)
                      WHERE NOT (o = ANY (dc.options)) ORDER BY i LIMIT greatest(0, 50 - cardinality(dc.options))) u), '{}')
           WHERE id = dc.id;
        END IF;
        CONTINUE;
      END IF;
      v_key := c.key;
      IF v_had THEN
        v_n := 2;
        LOOP
          v_key := left(c.key, 40 - length('_' || v_n)) || '_' || v_n;
          EXIT WHEN NOT EXISTS (SELECT 1 FROM public.custom_field_definition x WHERE x.table_id IN (p.id, v_dst) AND x.key = v_key);
          v_n := v_n + 1;
        END LOOP;
        UPDATE public.data_row
           SET custom_fields = (custom_fields - c.key) || jsonb_build_object(v_key, custom_fields -> c.key)
         WHERE table_id = p.id AND custom_fields ? c.key;
      END IF;
      SELECT coalesce(max(x.position) + 1, 0) INTO v_pos FROM public.custom_field_definition x WHERE x.table_id = v_dst;
      UPDATE public.custom_field_definition
         SET table_id = v_dst, workspace_id = p_dest, key = v_key, position = v_pos, system = false
       WHERE id = c.id;
    END LOOP;

    -- Its rows go after the destination's, its views show the destination,
    -- its edges name it; then it goes, and its columns and change log with it.
    SELECT coalesce(max(r.position), 0) INTO v_offset FROM public.data_row r WHERE r.table_id = v_dst;
    UPDATE public.data_row SET table_id = v_dst, workspace_id = p_dest, position = position + v_offset WHERE table_id = p.id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    n_rows := n_rows + v_rows;
    UPDATE public.view SET scope_id = v_dst WHERE scope_type = 'data_table' AND scope_id = p.id;
    DELETE FROM public.entity_link l
     WHERE l.target_type = 'data_table' AND l.target_id = p.id
       AND EXISTS (SELECT 1 FROM public.entity_link x
                    WHERE x.workspace_id IN (p_source, p_dest) AND x.source_type = l.source_type AND x.source_id = l.source_id
                      AND x.target_type = 'data_table' AND x.target_id = v_dst AND x.relation = l.relation);
    UPDATE public.entity_link SET target_id = v_dst WHERE target_type = 'data_table' AND target_id = p.id;
    DELETE FROM public.entity_access WHERE entity_type = 'data_table' AND entity_id = p.id;
    DELETE FROM public.data_table WHERE id = p.id;
    n_pipelines := n_pipelines + 1;
  END LOOP;

  -- A table's columns are its own (keys are per table): they move with the
  -- generic re-stamp, never fold. A field folds only into one of the same
  -- type and target (528: _wsmerge_custom_fields_begin gave the others a
  -- key of their own before anything moved).
  DELETE FROM public.custom_field_definition f
   WHERE f.workspace_id = p_source
     AND f.table_id IS NULL
     AND EXISTS (SELECT 1 FROM public.custom_field_definition d
                  WHERE d.workspace_id = p_dest AND d.entity_type = f.entity_type AND d.key = f.key AND d.table_id IS NULL
                    AND d.field_type = f.field_type
                    AND (d.config -> 'target') IS NOT DISTINCT FROM (f.config -> 'target'));
  GET DIAGNOSTICS n_fields = ROW_COUNT;

  -- People and linked records named in values follow the folds (528).
  RETURN jsonb_build_object('pipelines_folded', n_pipelines, 'deal_rows_moved', n_rows, 'custom_fields_folded', n_fields)
      || public._wsmerge_custom_field_ids(p_source, p_dest);
END;
$$;

REVOKE EXECUTE ON FUNCTION public._wsmerge_deals(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 6. The integrity sweep: a pipeline's rows in place of the deals
-- ------------------------------------------------------------

-- workspace_integrity_sweep, from 473_deals_pipelines_custom_fields.sql:
-- its last check is a pipeline's rows'.
CREATE OR REPLACE FUNCTION public.workspace_integrity_sweep(p_workspace uuid)
RETURNS TABLE (check_name text, violations bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH checks AS (
    SELECT 'actions.team_workspace' AS c, count(*) AS n FROM public.actions a JOIN public.team t ON t.id = a.team_id
      WHERE a.workspace_id = p_workspace AND t.workspace_id <> p_workspace
    UNION ALL SELECT 'actions.status_team', count(*) FROM public.actions a JOIN public.workflow_state s ON s.id = a.status_id
      WHERE a.workspace_id = p_workspace AND s.team_id <> a.team_id
    UNION ALL SELECT 'actions.assignee_member', count(*) FROM public.actions a JOIN public.member m ON m.id = a.assignee_id
      WHERE a.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'actions.assignee_ai_member', count(*) FROM public.actions a JOIN public.ai_team_member m ON m.id = a.assignee_ai_member_id
      WHERE a.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'actions.assignee_contact', count(*) FROM public.actions a JOIN public.contact c ON c.id = a.assignee_contact_id
      WHERE a.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'actions.project', count(*) FROM public.actions a JOIN public.projects p ON p.id = a.project_id
      WHERE a.workspace_id = p_workspace AND p.workspace_id <> p_workspace
    UNION ALL SELECT 'actions.milestone_project', count(*) FROM public.actions a JOIN public.milestone ms ON ms.id = a.milestone_id JOIN public.projects p ON p.id = ms.project_id
      WHERE a.workspace_id = p_workspace AND p.workspace_id <> p_workspace
    UNION ALL SELECT 'actions.cycle_team', count(*) FROM public.actions a JOIN public.cycle cy ON cy.id = a.cycle_id
      WHERE a.workspace_id = p_workspace AND cy.team_id <> a.team_id
    UNION ALL SELECT 'actions.parent', count(*) FROM public.actions a JOIN public.actions p ON p.id = a.parent_id
      WHERE a.workspace_id = p_workspace AND p.workspace_id <> p_workspace
    UNION ALL SELECT 'actions.source_capture', count(*) FROM public.actions a JOIN public.captures c ON c.id = a.source_capture_id
      WHERE a.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'action_assignee.member', count(*) FROM public.action_assignee x JOIN public.actions a ON a.id = x.action_id JOIN public.member m ON m.id = x.member_id
      WHERE a.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'action_label.label', count(*) FROM public.action_label x JOIN public.actions a ON a.id = x.action_id JOIN public.label l ON l.id = x.label_id
      WHERE a.workspace_id = p_workspace AND l.workspace_id <> p_workspace
    UNION ALL SELECT 'capture_label.label', count(*) FROM public.capture_label x JOIN public.captures a ON a.id = x.capture_id JOIN public.label l ON l.id = x.label_id
      WHERE a.workspace_id = p_workspace AND l.workspace_id <> p_workspace
    UNION ALL SELECT 'project_label.label', count(*) FROM public.project_label x JOIN public.projects a ON a.id = x.project_id JOIN public.label l ON l.id = x.label_id
      WHERE a.workspace_id = p_workspace AND l.workspace_id <> p_workspace
    UNION ALL SELECT 'initiative_label.label', count(*) FROM public.initiative_label x JOIN public.initiative a ON a.id = x.initiative_id JOIN public.label l ON l.id = x.label_id
      WHERE a.workspace_id = p_workspace AND l.workspace_id <> p_workspace
    UNION ALL SELECT 'email_thread_label.label', count(*) FROM public.email_thread_label x JOIN public.email_thread_index a ON a.id = x.thread_id JOIN public.label l ON l.id = x.label_id
      WHERE a.workspace_id = p_workspace AND l.workspace_id <> p_workspace
    UNION ALL SELECT 'action_relation.ends', count(*) FROM public.action_relation r JOIN public.actions a ON a.id = r.action_id JOIN public.actions b ON b.id = r.related_action_id
      WHERE a.workspace_id = p_workspace AND b.workspace_id <> p_workspace
    UNION ALL SELECT 'action_document.ends', count(*) FROM public.action_document r JOIN public.actions a ON a.id = r.action_id JOIN public.document d ON d.id = r.document_id
      WHERE a.workspace_id = p_workspace AND d.workspace_id <> p_workspace
    UNION ALL SELECT 'action_external_task.action', count(*) FROM public.action_external_task x JOIN public.actions a ON a.id = x.action_id
      WHERE x.workspace_id = p_workspace AND a.workspace_id <> p_workspace
    UNION ALL SELECT 'action_github_pr.action', count(*) FROM public.action_github_pr x JOIN public.actions a ON a.id = x.action_id
      WHERE x.workspace_id = p_workspace AND a.workspace_id <> p_workspace
    UNION ALL SELECT 'agent_run.action', count(*) FROM public.agent_run x JOIN public.actions a ON a.id = x.action_id
      WHERE x.workspace_id = p_workspace AND a.workspace_id <> p_workspace
    UNION ALL SELECT 'capture_chunks.capture', count(*) FROM public.capture_chunks x JOIN public.captures c ON c.id = x.capture_id
      WHERE x.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'capture_references.capture', count(*) FROM public.capture_references x JOIN public.captures c ON c.id = x.capture_id
      WHERE x.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'extraction_pass.capture', count(*) FROM public.extraction_pass x JOIN public.captures c ON c.id = x.capture_id
      WHERE x.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'capture_participant.member', count(*) FROM public.capture_participant x JOIN public.captures c ON c.id = x.capture_id JOIN public.member m ON m.id = x.member_id
      WHERE c.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'capture_participant.contact', count(*) FROM public.capture_participant x JOIN public.captures c ON c.id = x.capture_id JOIN public.contact ct ON ct.id = x.contact_id
      WHERE c.workspace_id = p_workspace AND ct.workspace_id <> p_workspace
    UNION ALL SELECT 'captures.team', count(*) FROM public.captures c JOIN public.team t ON t.id = c.team_id
      WHERE c.workspace_id = p_workspace AND t.workspace_id <> p_workspace
    UNION ALL SELECT 'captures.project', count(*) FROM public.captures c JOIN public.projects p ON p.id = c.project_id
      WHERE c.workspace_id = p_workspace AND p.workspace_id <> p_workspace
    UNION ALL SELECT 'document_chunks.document', count(*) FROM public.document_chunks x JOIN public.document d ON d.id = x.document_id
      WHERE x.workspace_id = p_workspace AND d.workspace_id <> p_workspace
    UNION ALL SELECT 'document_revision.document', count(*) FROM public.document_revision x JOIN public.document d ON d.id = x.document_id
      WHERE x.workspace_id = p_workspace AND d.workspace_id <> p_workspace
    UNION ALL SELECT 'document_draft.document', count(*) FROM public.document_draft x JOIN public.document d ON d.id = x.document_id
      WHERE x.workspace_id = p_workspace AND d.workspace_id <> p_workspace
    UNION ALL SELECT 'document.team', count(*) FROM public.document d JOIN public.team t ON t.id = d.team_id
      WHERE d.workspace_id = p_workspace AND t.workspace_id <> p_workspace
    UNION ALL SELECT 'document.project', count(*) FROM public.document d JOIN public.projects p ON p.id = d.project_id
      WHERE d.workspace_id = p_workspace AND p.workspace_id <> p_workspace
    UNION ALL SELECT 'document.created_by', count(*) FROM public.document d JOIN public.member m ON m.id = d.created_by
      WHERE d.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'claim_chunks.claim', count(*) FROM public.claim_chunks x JOIN public.claim c ON c.id = x.claim_id
      WHERE x.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'claim_source.claim', count(*) FROM public.claim_source x JOIN public.claim c ON c.id = x.claim_id
      WHERE x.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'claim.created_by', count(*) FROM public.claim c JOIN public.member m ON m.id = c.created_by
      WHERE c.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'attachments.parent', count(*) FROM public.attachments x
      LEFT JOIN public.captures c ON c.id = x.note_id LEFT JOIN public.actions a ON a.id = x.action_id LEFT JOIN public.projects p ON p.id = x.project_id
      WHERE x.workspace_id = p_workspace AND COALESCE(c.workspace_id, a.workspace_id, p.workspace_id) <> p_workspace
    UNION ALL SELECT 'attachment_chunks.attachment', count(*) FROM public.attachment_chunks x JOIN public.attachments a ON a.id = x.attachment_id
      WHERE x.workspace_id = p_workspace AND a.workspace_id <> p_workspace
    UNION ALL SELECT 'anchor_embedding.project', count(*) FROM public.anchor_embedding x JOIN public.projects p ON p.id = x.entity_id AND x.entity_type = 'project'
      WHERE x.workspace_id = p_workspace AND p.workspace_id <> p_workspace
    UNION ALL SELECT 'projects.initiative', count(*) FROM public.projects p JOIN public.initiative i ON i.id = p.initiative_id
      WHERE p.workspace_id = p_workspace AND i.workspace_id <> p_workspace
    UNION ALL SELECT 'projects.parent', count(*) FROM public.projects p JOIN public.projects q ON q.id = p.parent_project_id
      WHERE p.workspace_id = p_workspace AND q.workspace_id <> p_workspace
    UNION ALL SELECT 'projects.lead', count(*) FROM public.projects p JOIN public.member m ON m.id = p.lead_id
      WHERE p.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'proposed_change.capture', count(*) FROM public.proposed_change x JOIN public.captures c ON c.id = x.capture_id
      WHERE x.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'proposed_change.team', count(*) FROM public.proposed_change x JOIN public.team t ON t.id = x.team_id
      WHERE x.workspace_id = p_workspace AND t.workspace_id <> p_workspace
    UNION ALL SELECT 'proposed_change.assignee', count(*) FROM public.proposed_change x JOIN public.member m ON m.id = x.assignee_member_id
      WHERE x.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'decision.project', count(*) FROM public.decision d JOIN public.captures c ON c.id = d.capture_id JOIN public.projects p ON p.id = d.project_id
      WHERE c.workspace_id = p_workspace AND p.workspace_id <> p_workspace
    UNION ALL SELECT 'decision.decided_by', count(*) FROM public.decision d JOIN public.captures c ON c.id = d.capture_id JOIN public.member m ON m.id = d.decided_by
      WHERE c.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'chat_conversations.capture', count(*) FROM public.chat_conversations x JOIN public.captures c ON c.id = x.capture_id
      WHERE x.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'chat_conversations.teammate', count(*) FROM public.chat_conversations x JOIN public.ai_team_member m ON m.id = x.ai_team_member_id
      WHERE x.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'share.shareable', count(*) FROM public.share s
      LEFT JOIN public.captures c ON c.id = s.shareable_id AND s.shareable_type = 'capture'
      LEFT JOIN public.document d ON d.id = s.shareable_id AND s.shareable_type = 'document'
      WHERE s.workspace_id = p_workspace AND s.is_active AND COALESCE(c.workspace_id, d.workspace_id) <> p_workspace
    UNION ALL SELECT 'share.created_by', count(*) FROM public.share s JOIN public.member m ON m.id = s.created_by
      WHERE s.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'email_thread_index.links', count(*) FROM public.email_thread_index e
      LEFT JOIN public.actions a ON a.id = e.linked_action_id LEFT JOIN public.captures c ON c.id = e.linked_capture_id
      LEFT JOIN public.projects p ON p.id = e.linked_project_id LEFT JOIN public.contact ct ON ct.id = e.linked_contact_id
      WHERE e.workspace_id = p_workspace AND (a.workspace_id <> p_workspace OR c.workspace_id <> p_workspace OR p.workspace_id <> p_workspace OR ct.workspace_id <> p_workspace)
    UNION ALL SELECT 'entity_link.ends', count(*) FROM public.entity_link l
      WHERE l.workspace_id = p_workspace AND (
        EXISTS (SELECT 1 FROM public.actions a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.captures a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.document a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.projects a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.contact a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.company a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.claim a WHERE a.id IN (l.source_id, l.target_id) AND a.workspace_id <> p_workspace))
    UNION ALL SELECT 'knowledge_package_item.entity', count(*) FROM public.knowledge_package_item i
      WHERE i.workspace_id = p_workspace AND (
        EXISTS (SELECT 1 FROM public.actions a WHERE a.id = i.entity_id AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.captures a WHERE a.id = i.entity_id AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.document a WHERE a.id = i.entity_id AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.projects a WHERE a.id = i.entity_id AND a.workspace_id <> p_workspace)
        OR EXISTS (SELECT 1 FROM public.claim a WHERE a.id = i.entity_id AND a.workspace_id <> p_workspace))
    UNION ALL SELECT 'knowledge_package.team', count(*) FROM public.knowledge_package k JOIN public.team t ON t.id = k.team_id
      WHERE k.workspace_id = p_workspace AND t.workspace_id <> p_workspace
    UNION ALL SELECT 'comment.author', count(*) FROM public.comment x JOIN public.member m ON m.id = x.author_id
      WHERE m.workspace_id <> p_workspace AND (
        EXISTS (SELECT 1 FROM public.actions a WHERE a.id = x.commentable_id AND a.workspace_id = p_workspace)
        OR EXISTS (SELECT 1 FROM public.captures a WHERE a.id = x.commentable_id AND a.workspace_id = p_workspace)
        OR EXISTS (SELECT 1 FROM public.document a WHERE a.id = x.commentable_id AND a.workspace_id = p_workspace)
        OR EXISTS (SELECT 1 FROM public.projects a WHERE a.id = x.commentable_id AND a.workspace_id = p_workspace)
        OR EXISTS (SELECT 1 FROM public.contact a WHERE a.id = x.commentable_id AND a.workspace_id = p_workspace))
    UNION ALL SELECT 'team_member.member', count(*) FROM public.team_member x JOIN public.team t ON t.id = x.team_id JOIN public.member m ON m.id = x.member_id
      WHERE t.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'ai_team_member.team', count(*) FROM public.ai_team_member x JOIN public.team t ON t.id = x.team_id
      WHERE x.workspace_id = p_workspace AND t.workspace_id <> p_workspace
    UNION ALL SELECT 'flow.team', count(*) FROM public.flow x JOIN public.team t ON t.id = x.team_id
      WHERE x.workspace_id = p_workspace AND t.workspace_id <> p_workspace
    UNION ALL SELECT 'flow.teammate', count(*) FROM public.flow x JOIN public.ai_team_member m ON m.id = x.ai_team_member_id
      WHERE x.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'view.team', count(*) FROM public.view x JOIN public.team t ON t.id = x.team_id
      WHERE x.workspace_id = p_workspace AND t.workspace_id <> p_workspace
    UNION ALL SELECT 'contact.company', count(*) FROM public.contact c JOIN public.company co ON co.id = c.company_id
      WHERE c.workspace_id = p_workspace AND co.workspace_id <> p_workspace
    UNION ALL SELECT 'contact.member', count(*) FROM public.contact c JOIN public.member m ON m.id = c.member_id
      WHERE c.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'contact.created_by', count(*) FROM public.contact c JOIN public.member m ON m.id = c.created_by_member_id
      WHERE c.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'contact_share.target', count(*) FROM public.contact_share s
      LEFT JOIN public.member m ON m.id = s.shared_with_member_id LEFT JOIN public.team t ON t.id = s.shared_with_team_id
      WHERE s.workspace_id = p_workspace AND (m.workspace_id <> p_workspace OR t.workspace_id <> p_workspace)
    UNION ALL SELECT 'contact_share.contact', count(*) FROM public.contact_share s JOIN public.contact c ON c.id = s.contact_id
      WHERE s.workspace_id = p_workspace AND c.workspace_id <> p_workspace
    UNION ALL SELECT 'initiative.owner', count(*) FROM public.initiative i JOIN public.member m ON m.id = i.owner_id
      WHERE i.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'notification.recipient', count(*) FROM public.notification n JOIN public.member m ON m.id = n.recipient_id
      WHERE n.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'attention_item.member', count(*) FROM public.attention_item n JOIN public.member m ON m.id = n.member_id
      WHERE n.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'tracked_job.member', count(*) FROM public.tracked_job n JOIN public.member m ON m.id = n.member_id
      WHERE n.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'tool_approval.member', count(*) FROM public.tool_approval n JOIN public.member m ON m.id = n.member_id
      WHERE n.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'invite.invited_by', count(*) FROM public.invite n JOIN public.member m ON m.id = n.invited_by
      WHERE n.workspace_id = p_workspace AND m.workspace_id <> p_workspace
    UNION ALL SELECT 'connected_account_workspace.home', count(*) FROM public.connected_account_workspace j JOIN public.connected_account a ON a.id = j.account_id
      WHERE j.workspace_id = p_workspace AND a.workspace_id = p_workspace AND j.workspace_id <> a.workspace_id
  )
  SELECT c, n FROM checks WHERE n > 0;

  -- Pipelines (540): a deal's table and owner are its own workspace's.
  RETURN QUERY
  WITH checks AS (
    SELECT 'pipeline_row.table' AS c, count(*) AS n FROM public.data_row r JOIN public.data_table t ON t.id = r.table_id
      WHERE r.workspace_id = p_workspace AND t.workspace_id <> p_workspace
    UNION ALL SELECT 'pipeline_row.owner', count(*) FROM public.data_row r
      JOIN public.data_table t ON t.id = r.table_id AND t.kind = 'pipeline'
      JOIN public.member m ON m.id::text = r.custom_fields ->> 'owner'
      WHERE r.workspace_id = p_workspace AND m.workspace_id <> p_workspace
  )
  SELECT c, n FROM checks WHERE n > 0;
END;
$$;

notify pgrst, 'reload schema';
