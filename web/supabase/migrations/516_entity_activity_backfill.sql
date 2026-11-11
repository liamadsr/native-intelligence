-- ============================================================
-- 516: the activity log's history, backfilled (the shared entity layer,
-- follow-up F).
-- ============================================================
-- The log (488, 489, 497) began the day its triggers did, so every record
-- older than that had a blank History. This writes what the existing data
-- already says happened, once:
--
--   created          every logged kind, at the record's created_at, by its
--                    maker where the row names one (a task's, capture's or
--                    project's user_id, a document's created_by, a contact's
--                    created_by_member_id, a deal's created_by_user_id, a
--                    loop's created_by), as a member of the record's own
--                    workspace; the system otherwise. An agent's, as the
--                    live trigger credits one (actor 'agent', for the member
--                    it worked for), where the row says an agent made it: a
--                    task from a chat or a meeting's extraction, a deal made
--                    from a meeting. The same rows the live
--                    triggers leave out stay out: suggested tasks,
--                    evaluation captures, synced or imported contacts and
--                    companies, contacts merged into another.
--   archived         a document, capture, project or initiative archived
--                    now, at its updated_at (no column keeps the moment
--                    itself; the last write is the closest the data has).
--                    The system's: nothing says who archived it.
--   status_changed   a task in a completed or canceled state, at its
--                    completed_at; a deal whose stage moved after it was
--                    made, at its stage_changed_at. Detail {from: null, to}:
--                    the state or stage it is in now. The system's: nothing
--                    says who moved it.
--   commented        every comment, at its created_at, by its author (488's
--                    commented kinds: task, capture, document, project,
--                    contact).
--   mentioned /      every edge (entity_link) but a claim's, at its
--   linked           created_at, by its created_by, with exactly the rows
--                    and detail 488's edge trigger writes.
-- Nothing else is guessed: no rename, assignment or stage path is invented
-- from a record's present state.
--
-- Backfilled rows are marked (entity_activity.backfilled). The Inbox skips
-- them (src/lib/entities/feed.ts): a mention of you from last month is
-- History, not news. History and Recent keep them.
--
-- Never twice:
--   - a row the live triggers already wrote stops the same row here (a
--     record made after 488 has its 'created'; an edge its 'linked'): one
--     indexed probe of (entity_type, entity_id) per candidate;
--   - each backfilled row's id is derived from what it records
--     (entity_activity_backfill_id), so a second run, or two at once,
--     conflicts on the primary key and writes nothing;
--   - a record batch takes its locks in one statement and writes in the
--     next, so the probe reads a snapshot taken after every change it waited
--     on (an archive or a completion committed meanwhile, with its live row).
--
-- Batched: entity_activity_backfill_step() does ONE batch of one source
-- (1000 rows by default, in primary-key order past where the last batch
-- stopped; entity_activity_backfill_progress keeps the place) and returns
-- what it did. Migration 517 runs the steps from pg_cron, one per tick, each
-- its own transaction, until every source is done, then unschedules itself.
-- A batch is a key-ordered index scan of its source and one probe per
-- candidate: flat cost, whatever the workspace.
--
-- Moves and merges, as 489:
--   - a row is stamped with the record's workspace NOW (an edge's rows also
--     need both of its records to live in the edge's workspace; a stale edge
--     writes nothing);
--   - each batch holds FOR SHARE on the records it stamps until it commits,
--     so a move (221) of one of them waits for the batch, and its re-stamp
--     (entity_activity_follow) then carries the backfilled rows too; a move
--     that went first is seen by the batch, which stamps the new workspace;
--   - nothing is written while any merge job is queued or running (402,
--     417): the step waits for the next tick; a merge started after a
--     batch read its rows waits on the batch's foreign-key lock on the
--     workspace row, then re-stamps what the batch wrote; and
--     entity_activity_writable (not inside a merge, the workspace still
--     there) gates every row, as it gates every trigger.
--
-- A run that wrote nothing, while documents, projects, initiatives, deals or
-- loops exist (the catalog's row count, which row security cannot hide),
-- fails its last step instead of finishing: the owner most likely reads
-- through row security.
--
-- Who may do what: nothing here is callable by anon or authenticated; the
-- step and the tick run as their owner. The progress and run tables have
-- row security on and no policies.
--
-- Idempotent (if not exists, create or replace, on conflict do nothing).
-- No backslashes anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- ── The mark ────────────────────────────────────────────────────────────────
alter table public.entity_activity add column if not exists backfilled boolean not null default false;

comment on column public.entity_activity.backfilled is
  'Written by the one-time history backfill (migration 516), not by a live trigger. The Inbox skips these rows.';

-- ── Where the backfill is ───────────────────────────────────────────────────
create table if not exists public.entity_activity_backfill_progress (
  source text primary key,
  ord smallint not null,
  -- The last primary key a batch of this source read (null: not started).
  after_id uuid null,
  seen bigint not null default 0,
  inserted bigint not null default 0,
  failures integer not null default 0,
  last_error text null,
  done_at timestamptz null,
  updated_at timestamptz not null default now()
);

alter table public.entity_activity_backfill_progress enable row level security;
revoke all on public.entity_activity_backfill_progress from anon, authenticated;

insert into public.entity_activity_backfill_progress (source, ord) values
  ('action', 1), ('document', 2), ('capture', 3), ('project', 4), ('initiative', 5),
  ('contact', 6), ('company', 7), ('deal', 8), ('flow', 9), ('comment', 10), ('entity_link', 11)
on conflict (source) do nothing;

-- ── A backfilled row's id: the same facts, the same id ──────────────────────
create or replace function public.entity_activity_backfill_id(variadic p_parts text[])
returns uuid
language sql
immutable
set search_path = public, pg_temp
as $$
  select md5('entity_activity_backfill:' || array_to_string(p_parts, ':', ''))::uuid;
$$;

revoke all on function public.entity_activity_backfill_id(text[]) from public, anon, authenticated;

-- ── A logged record's workspace now, locked for the batch ───────────────────
-- Null for a record that is gone, or one the log never shows (a suggested
-- task is shown once confirmed, but its edges and comments are logged live
-- as well, so they are here too; an evaluation capture, a merged contact, a
-- deleted message are not). Every kind the registry marks `activity` has a
-- branch (src/lib/entities/__tests__/migration-516.test.ts holds the list).
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
    when 'deal' then (select x.workspace_id from public.deal x where x.id = p_id for share)
    when 'flow' then (select x.workspace_id from public.flow x where x.id = p_id for share)
    when 'team_chat_message' then (select x.workspace_id from public.team_chat_message x where x.id = p_id and x.deleted_at is null for share)
  end;
$$;

revoke all on function public.entity_activity_backfill_home(text, uuid) from public, anon, authenticated;

-- ── One batch of one source ─────────────────────────────────────────────────
-- Returns {source, seen, inserted, done}; {finished: true} once every source
-- is done; {waiting: 'merge'} while a merge job is queued or running;
-- {busy: true} while another step holds the next source.
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
  kinds constant text[] := array['action', 'document', 'capture', 'project', 'initiative', 'contact', 'company', 'deal', 'flow', 'team_chat_message'];
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

  -- ── Deals: created; the stage it moved to ─────────────────────────────────
  elsif p.source = 'deal' then
    select coalesce(array_agg(s.id order by s.id), '{}') into v_ids
      from (select x.id from public.deal x
             where x.id > v_after
             order by x.id
             limit p_limit
               for share of x) s;
    with b as (
      select x.id, x.workspace_id, x.created_by_user_id, x.created_at, x.stage_id, x.stage_changed_at,
             -- Made by an agent from a meeting (the capture-to-deal path).
             x.source is not distinct from 'capture' as by_agent
        from public.deal x
       where x.id = any(v_ids)
    ), ins as (
      insert into public.entity_activity (id, workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, detail, created_at, backfilled)
      select public.entity_activity_backfill_id('deal', b.id::text, v.action), b.workspace_id, 'deal', b.id, v.action,
             case when v.action <> 'created' or m.id is null then 'system' when b.by_agent then 'agent' else 'member' end, case when v.action = 'created' then m.id end, v.detail, v.at, true
        from b
        left join public.member m on m.user_id = b.created_by_user_id and m.workspace_id = b.workspace_id
        cross join lateral (values
          ('created', '{}'::jsonb, b.created_at, array['created'], true),
          ('status_changed', jsonb_build_object('from', null, 'to', b.stage_id), b.stage_changed_at, array['status_changed'],
            b.stage_id is not null and b.stage_changed_at > b.created_at + interval '1 second')
        ) v(action, detail, at, logged, hit)
       where v.hit
         and public.entity_activity_writable(b.workspace_id)
         and not exists (select 1 from public.entity_activity e where e.entity_type = 'deal' and e.entity_id = b.id and e.action = any(v.logged))
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
                     'public.deal'::regclass, 'public.flow'::regclass);
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

-- ── The run: when 517 started it, when a batch last moved, why it stopped ──
create table if not exists public.entity_activity_backfill_run (
  id boolean primary key default true check (id),
  scheduled_at timestamptz not null default now(),
  last_progress_at timestamptz not null default now(),
  stopped_at timestamptz null,
  stop_reason text null
);

alter table public.entity_activity_backfill_run enable row level security;
revoke all on public.entity_activity_backfill_run from anon, authenticated;

-- ── Stop the job: unschedule it; its run log is cleared if it can be ───────
create or replace function public.entity_activity_backfill_unschedule()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- The run log is housekeeping: a role that may not delete it still stops the job.
  begin
    delete from cron.job_run_details where jobid in (select jobid from cron.job where jobname = 'entity-activity-backfill');
  exception when others then
    raise warning 'entity_activity_backfill: run log not cleared: %', sqlerrm;
  end;
  if exists (select 1 from cron.job where jobname = 'entity-activity-backfill') then
    perform cron.unschedule('entity-activity-backfill');
  end if;
end;
$$;

revoke all on function public.entity_activity_backfill_unschedule() from public, anon, authenticated;

-- ── The pg_cron tick (517 schedules it) ─────────────────────────────────────
-- One batch per tick. The job unschedules itself, with the reason on
-- entity_activity_backfill_run, when:
--   - every source is done;
--   - 30 batches in a row failed (a lock wait past 2 s is retried; the error
--     is on the source's progress row);
--   - a merge job has been queued for more than 10 minutes (the backfill
--     waits for merges; run 517 again once it is through);
--   - no batch moved for 10 minutes, or 60 minutes passed since 517
--     scheduled it, whatever the reason.
-- A tick that never runs at all (pg_cron cannot connect) cannot stop
-- itself: cron.job_run_details shows it, and
-- select cron.unschedule('entity-activity-backfill') stops it.
create or replace function public.entity_activity_backfill_tick()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r jsonb;
  v_msg text;
  v_stop text;
  v_run public.entity_activity_backfill_run%rowtype;
  v_merge_since timestamptz;
begin
  insert into public.entity_activity_backfill_run (id) values (true) on conflict (id) do nothing;
  select * into v_run from public.entity_activity_backfill_run where id;

  if v_run.stopped_at is not null then
    v_stop := v_run.stop_reason;
  elsif now() > v_run.scheduled_at + interval '60 minutes' then
    v_stop := 'ran past its 60-minute limit';
  elsif now() > v_run.last_progress_at + interval '10 minutes' then
    v_stop := 'no batch moved for 10 minutes';
  else
    begin
      r := public.entity_activity_backfill_step(1000);
      if r ? 'source' then
        update public.entity_activity_backfill_run set last_progress_at = now() where id;
      end if;
      if coalesce((r ->> 'finished')::boolean, false) then
        v_stop := 'finished';
      elsif r ? 'waiting' then
        select min(j.created_at) into v_merge_since from public.workspace_merge_job j where j.status = 'queued';
        if v_merge_since < now() - interval '10 minutes' then
          v_stop := 'a merge job has been queued since ' || v_merge_since::text || '; apply 517 again once it is through';
          update public.entity_activity_backfill_progress
             set last_error = v_stop, updated_at = now()
           where source = (select q.source from public.entity_activity_backfill_progress q where q.done_at is null order by q.ord limit 1);
        end if;
      end if;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      update public.entity_activity_backfill_progress
         set failures = failures + 1, last_error = left(v_msg, 500), updated_at = now()
       where source = (select q.source from public.entity_activity_backfill_progress q where q.done_at is null order by q.ord limit 1);
      if exists (select 1 from public.entity_activity_backfill_progress where done_at is null and failures >= 30) then
        v_stop := 'failed 30 times in a row: ' || left(v_msg, 300);
      end if;
    end;
  end if;

  if v_stop is not null then
    update public.entity_activity_backfill_run
       set stopped_at = coalesce(stopped_at, now()), stop_reason = coalesce(stop_reason, v_stop)
     where id;
    perform public.entity_activity_backfill_unschedule();
  end if;
end;
$$;

revoke all on function public.entity_activity_backfill_tick() from public, anon, authenticated;

notify pgrst, 'reload schema';
