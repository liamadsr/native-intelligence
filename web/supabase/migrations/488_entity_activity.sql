-- ============================================================
-- 488: one activity log for the registered kinds (the shared entity layer,
-- phase 4).
-- ============================================================
-- What lands:
--   entity_activity   one row per thing that happened to a record: workspace,
--                     the record (entity_type, entity_id), the action, who did
--                     it (actor_kind member | agent | system, actor_member_id),
--                     the member it is about (subject_member_id: who was
--                     assigned, who was @-mentioned), a compact detail and
--                     when. The cross-kind feed (GET /api/account/feed) reads
--                     it: an Inbox (mentioned / assigned to me), Recent (what
--                     I touched) and a record's History.
--   triggers          lean ones on the kinds the registry marks `activity`
--                     (src/lib/knowledge/entity-registry.ts), plus comment,
--                     entity_link and team_chat_message, so EVERY writer is
--                     logged (the app, agents, MCP, cron, service role) and no
--                     route changes.
--
-- The vocabulary (detail in brackets):
--   created          a record came to be (a suggested task once confirmed)
--   renamed          its title or name changed           {}
--   status_changed   its state, stage or on/off changed  {from, to}
--   assigned         its assignee, lead or owner changed {from, to}
--   archived / restored                                  {}
--   mentioned        someone @-mentioned it, or a member in it
--                                                        {source_type, source_id}
--   commented        a comment on it                     {comment_id}
--   linked           an edge to or from it               {other_type, other_id, relation}
-- Detail never holds a title or any text: labels are read through the
-- viewer's own RLS (and the private-kind fences) when the feed answers.
--
-- Cost, by design:
--   - INSERTs log from a statement-level trigger over the transition table:
--     one insert per statement however many rows (a bulk import or a calendar
--     sync is one statement, not one per row).
--   - UPDATEs log from a row-level trigger with a column list AND a WHEN
--     clause: an update that changes none of the columns that matter (a
--     document autosave, a transcript, a sync's touch) never calls the
--     function at all.
--   - The actor is auth.uid()'s member (one indexed read of
--     member_user_id_workspace_id_key), else the agent a server request
--     names (the x-activity-actor header the eve tool routes send), else
--     system. No other reads.
--   - A logging failure is a WARNING, never the write's failure.
--   - Left out, deliberately: mail (email_thread_index, batch-heavy), claims
--     and their edges (extraction volume), calendar events (provider syncs),
--     contacts and companies a sync or an import created (calendar_sync,
--     capture_participant, email_sync, hubspot, import…), evaluation
--     captures, suggested tasks until they are confirmed.
--
-- Retention: not built. The log grows with the workspace's real activity
-- (no churny writers); a later job can drop rows past a year by
-- (workspace_id, created_at), which the second index serves.
--
-- Who may do what: workspace members read (is_workspace_member); nobody
-- writes but the triggers (SECURITY DEFINER). The feed route re-applies each
-- private kind's visibility before it answers.
--
-- Idempotent. No backslashes anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

create table if not exists public.entity_activity (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  action text not null,
  actor_kind text not null default 'system',
  -- A plain id, not a foreign key: a departed member's history survives them.
  actor_member_id uuid null,
  subject_member_id uuid null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint entity_activity_action_check check (action in (
    'created', 'renamed', 'status_changed', 'assigned', 'archived', 'restored',
    'mentioned', 'commented', 'linked'
  )),
  constraint entity_activity_actor_kind_check check (actor_kind in ('member', 'agent', 'system')),
  constraint entity_activity_detail_check check (jsonb_typeof(detail) = 'object')
);

-- By record: a record's History.
create index if not exists entity_activity_entity_idx
  on public.entity_activity (entity_type, entity_id, created_at desc);
-- By workspace and time: the workspace's feed (and retention later).
create index if not exists entity_activity_workspace_idx
  on public.entity_activity (workspace_id, created_at desc, id desc);
-- Involving a member: the Inbox (mentioned / assigned to them).
create index if not exists entity_activity_subject_idx
  on public.entity_activity (subject_member_id, created_at desc)
  where subject_member_id is not null;
-- By a member's own hand: Recent.
create index if not exists entity_activity_actor_idx
  on public.entity_activity (actor_member_id, created_at desc)
  where actor_member_id is not null;

alter table public.entity_activity enable row level security;

drop policy if exists entity_activity_member_select on public.entity_activity;
create policy entity_activity_member_select on public.entity_activity
  for select using (public.is_workspace_member(workspace_id));

revoke insert, update, delete on public.entity_activity from anon, authenticated;
revoke all on public.entity_activity from anon;

-- ── Who did it ──────────────────────────────────────────────────────────────
-- A signed-in request: its user (the trigger finds their member in the row's
-- workspace). A server request (service role, no auth.uid()) that names an
-- agent in its headers (src/lib/admin.ts getAgentServiceClient: the eve tool
-- routes) is that agent, acting for the user it names. Anything else (cron,
-- Inngest, a webhook, a migration) is the system. A client can't pass for an
-- agent: a signed-in request is always its own member.
create or replace function public.entity_activity_actor(out actor_kind text, out actor_user_id uuid)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  raw text;
  h jsonb;
  u text;
begin
  actor_user_id := auth.uid();
  if actor_user_id is not null then
    actor_kind := 'member';
    return;
  end if;
  raw := nullif(current_setting('request.headers', true), '');
  if raw is not null and left(ltrim(raw), 1) = '{' then
    h := raw::jsonb;
  end if;
  if h ->> 'x-activity-actor' = 'agent' then
    actor_kind := 'agent';
    u := h ->> 'x-activity-user';
    if u ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      actor_user_id := u::uuid;
    end if;
  else
    actor_kind := 'system';
  end if;
end;
$$;

revoke all on function public.entity_activity_actor() from public, anon, authenticated;

-- The actor's member in a workspace, or null.
create or replace function public.entity_activity_member(p_user uuid, p_workspace uuid)
returns uuid
language sql
stable
set search_path = public, pg_temp
as $$
  select m.id from public.member m where p_user is not null and m.user_id = p_user and m.workspace_id = p_workspace limit 1;
$$;

revoke all on function public.entity_activity_member(uuid, uuid) from public, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- Tasks (actions): created (once confirmed), renamed, status_changed, assigned
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.entity_activity_actions_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
begin
  begin
    select * into a from public.entity_activity_actor();
    insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, subject_member_id, detail)
    select n.workspace_id, 'action', n.id, v.action, a.actor_kind, m.id, v.subject, v.detail
      from new_rows n
      left join public.member m on m.user_id = a.actor_user_id and m.workspace_id = n.workspace_id
      cross join lateral (values
        ('created', null::uuid, '{}'::jsonb, true),
        ('assigned', n.assignee_id, jsonb_build_object('from', null, 'to', n.assignee_id), n.assignee_id is not null)
      ) v(action, subject, detail, hit)
     where v.hit
       and n.workspace_id is not null
       and n.confirmation is distinct from 'suggested';
  exception when others then
    raise warning 'entity_activity (actions insert): % %', sqlstate, sqlerrm;
  end;
  return null;
end;
$$;

create or replace function public.entity_activity_actions_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
  live boolean := old.confirmation is distinct from 'suggested';
begin
  if new.workspace_id is null or new.confirmation = 'suggested' then
    return null;
  end if;
  begin
    select * into a from public.entity_activity_actor();
    insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, subject_member_id, detail)
    select new.workspace_id, 'action', new.id, v.action, a.actor_kind,
           public.entity_activity_member(a.actor_user_id, new.workspace_id), v.subject, v.detail
      from (values
        ('created', null::uuid, '{}'::jsonb, not live),
        ('renamed', null::uuid, '{}'::jsonb, live and old.title is distinct from new.title),
        ('status_changed', null::uuid, jsonb_build_object('from', old.status_id, 'to', new.status_id), live and old.status_id is distinct from new.status_id),
        ('assigned', new.assignee_id, jsonb_build_object('from', case when live then old.assignee_id end, 'to', new.assignee_id),
          (live and old.assignee_id is distinct from new.assignee_id) or (not live and new.assignee_id is not null))
      ) v(action, subject, detail, hit)
     where v.hit;
  exception when others then
    raise warning 'entity_activity (actions update): % %', sqlstate, sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists entity_activity_insert on public.actions;
create trigger entity_activity_insert
  after insert on public.actions
  referencing new table as new_rows
  for each statement execute function public.entity_activity_actions_insert();

drop trigger if exists entity_activity_update on public.actions;
create trigger entity_activity_update
  after update of title, status_id, assignee_id, confirmation on public.actions
  for each row
  when (old.title is distinct from new.title
     or old.status_id is distinct from new.status_id
     or old.assignee_id is distinct from new.assignee_id
     or old.confirmation is distinct from new.confirmation)
  execute function public.entity_activity_actions_update();

-- ════════════════════════════════════════════════════════════════════════════
-- Documents: created, renamed, archived / restored, status_changed
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.entity_activity_document_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
begin
  begin
    select * into a from public.entity_activity_actor();
    insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id)
    select n.workspace_id, 'document', n.id, 'created', a.actor_kind, m.id
      from new_rows n
      left join public.member m on m.user_id = a.actor_user_id and m.workspace_id = n.workspace_id
     where n.workspace_id is not null;
  exception when others then
    raise warning 'entity_activity (document insert): % %', sqlstate, sqlerrm;
  end;
  return null;
end;
$$;

create or replace function public.entity_activity_document_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
begin
  if new.workspace_id is null then
    return null;
  end if;
  begin
    select * into a from public.entity_activity_actor();
    insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, detail)
    select new.workspace_id, 'document', new.id, v.action, a.actor_kind,
           public.entity_activity_member(a.actor_user_id, new.workspace_id), v.detail
      from (values
        ('renamed', '{}'::jsonb, old.title is distinct from new.title),
        ('archived', '{}'::jsonb, new.status = 'archived' and old.status is distinct from 'archived'),
        ('restored', '{}'::jsonb, old.status = 'archived' and new.status is distinct from 'archived'),
        ('status_changed', jsonb_build_object('from', old.status, 'to', new.status),
          old.status is distinct from new.status and old.status is distinct from 'archived' and new.status is distinct from 'archived')
      ) v(action, detail, hit)
     where v.hit;
  exception when others then
    raise warning 'entity_activity (document update): % %', sqlstate, sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists entity_activity_insert on public.document;
create trigger entity_activity_insert
  after insert on public.document
  referencing new table as new_rows
  for each statement execute function public.entity_activity_document_insert();

drop trigger if exists entity_activity_update on public.document;
create trigger entity_activity_update
  after update of title, status on public.document
  for each row
  when (old.title is distinct from new.title or old.status is distinct from new.status)
  execute function public.entity_activity_document_update();

-- ════════════════════════════════════════════════════════════════════════════
-- Captures: created, renamed, archived / restored (a processing state is not
-- activity). Evaluation captures are never in the product.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.entity_activity_captures_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
begin
  begin
    select * into a from public.entity_activity_actor();
    insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id)
    select n.workspace_id, 'capture', n.id, 'created', a.actor_kind, m.id
      from new_rows n
      left join public.member m on m.user_id = a.actor_user_id and m.workspace_id = n.workspace_id
     where n.workspace_id is not null and n.is_eval is not true;
  exception when others then
    raise warning 'entity_activity (captures insert): % %', sqlstate, sqlerrm;
  end;
  return null;
end;
$$;

create or replace function public.entity_activity_captures_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
begin
  if new.workspace_id is null or new.is_eval is true then
    return null;
  end if;
  begin
    select * into a from public.entity_activity_actor();
    insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id)
    select new.workspace_id, 'capture', new.id, v.action, a.actor_kind,
           public.entity_activity_member(a.actor_user_id, new.workspace_id)
      from (values
        ('renamed', old.title is distinct from new.title),
        ('archived', new.status = 'archived' and old.status is distinct from 'archived'),
        ('restored', old.status = 'archived' and new.status is distinct from 'archived')
      ) v(action, hit)
     where v.hit;
  exception when others then
    raise warning 'entity_activity (captures update): % %', sqlstate, sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists entity_activity_insert on public.captures;
create trigger entity_activity_insert
  after insert on public.captures
  referencing new table as new_rows
  for each statement execute function public.entity_activity_captures_insert();

drop trigger if exists entity_activity_update on public.captures;
create trigger entity_activity_update
  after update of title, status on public.captures
  for each row
  when (old.title is distinct from new.title
     or (old.status = 'archived') is distinct from (new.status = 'archived'))
  execute function public.entity_activity_captures_update();

-- ════════════════════════════════════════════════════════════════════════════
-- Projects: created, renamed, status_changed, assigned (lead), archived / restored
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.entity_activity_projects_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
begin
  begin
    select * into a from public.entity_activity_actor();
    insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, subject_member_id, detail)
    select n.workspace_id, 'project', n.id, v.action, a.actor_kind, m.id, v.subject, v.detail
      from new_rows n
      left join public.member m on m.user_id = a.actor_user_id and m.workspace_id = n.workspace_id
      cross join lateral (values
        ('created', null::uuid, '{}'::jsonb, true),
        ('assigned', n.lead_id, jsonb_build_object('from', null, 'to', n.lead_id), n.lead_id is not null)
      ) v(action, subject, detail, hit)
     where v.hit and n.workspace_id is not null;
  exception when others then
    raise warning 'entity_activity (projects insert): % %', sqlstate, sqlerrm;
  end;
  return null;
end;
$$;

create or replace function public.entity_activity_projects_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
begin
  if new.workspace_id is null then
    return null;
  end if;
  begin
    select * into a from public.entity_activity_actor();
    insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, subject_member_id, detail)
    select new.workspace_id, 'project', new.id, v.action, a.actor_kind,
           public.entity_activity_member(a.actor_user_id, new.workspace_id), v.subject, v.detail
      from (values
        ('renamed', null::uuid, '{}'::jsonb, old.name is distinct from new.name),
        ('status_changed', null::uuid, jsonb_build_object('from', old.status, 'to', new.status), old.status is distinct from new.status),
        ('assigned', new.lead_id, jsonb_build_object('from', old.lead_id, 'to', new.lead_id), old.lead_id is distinct from new.lead_id),
        ('archived', null::uuid, '{}'::jsonb, new.is_archived is true and old.is_archived is not true),
        ('restored', null::uuid, '{}'::jsonb, old.is_archived is true and new.is_archived is not true)
      ) v(action, subject, detail, hit)
     where v.hit;
  exception when others then
    raise warning 'entity_activity (projects update): % %', sqlstate, sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists entity_activity_insert on public.projects;
create trigger entity_activity_insert
  after insert on public.projects
  referencing new table as new_rows
  for each statement execute function public.entity_activity_projects_insert();

drop trigger if exists entity_activity_update on public.projects;
create trigger entity_activity_update
  after update of name, status, lead_id, is_archived on public.projects
  for each row
  when (old.name is distinct from new.name
     or old.status is distinct from new.status
     or old.lead_id is distinct from new.lead_id
     or old.is_archived is distinct from new.is_archived)
  execute function public.entity_activity_projects_update();

-- ════════════════════════════════════════════════════════════════════════════
-- Initiatives: created, renamed, status_changed, assigned (owner), archived / restored
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.entity_activity_initiative_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
begin
  begin
    select * into a from public.entity_activity_actor();
    insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, subject_member_id, detail)
    select n.workspace_id, 'initiative', n.id, v.action, a.actor_kind, m.id, v.subject, v.detail
      from new_rows n
      left join public.member m on m.user_id = a.actor_user_id and m.workspace_id = n.workspace_id
      cross join lateral (values
        ('created', null::uuid, '{}'::jsonb, true),
        ('assigned', n.owner_id, jsonb_build_object('from', null, 'to', n.owner_id), n.owner_id is not null)
      ) v(action, subject, detail, hit)
     where v.hit and n.workspace_id is not null;
  exception when others then
    raise warning 'entity_activity (initiative insert): % %', sqlstate, sqlerrm;
  end;
  return null;
end;
$$;

create or replace function public.entity_activity_initiative_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
  was_archived boolean := old.status::text = 'archived';
  is_archived boolean := new.status::text = 'archived';
begin
  if new.workspace_id is null then
    return null;
  end if;
  begin
    select * into a from public.entity_activity_actor();
    insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, subject_member_id, detail)
    select new.workspace_id, 'initiative', new.id, v.action, a.actor_kind,
           public.entity_activity_member(a.actor_user_id, new.workspace_id), v.subject, v.detail
      from (values
        ('renamed', null::uuid, '{}'::jsonb, old.name is distinct from new.name),
        ('archived', null::uuid, '{}'::jsonb, is_archived and not was_archived),
        ('restored', null::uuid, '{}'::jsonb, was_archived and not is_archived),
        ('status_changed', null::uuid, jsonb_build_object('from', old.status, 'to', new.status),
          old.status is distinct from new.status and not was_archived and not is_archived),
        ('assigned', new.owner_id, jsonb_build_object('from', old.owner_id, 'to', new.owner_id), old.owner_id is distinct from new.owner_id)
      ) v(action, subject, detail, hit)
     where v.hit;
  exception when others then
    raise warning 'entity_activity (initiative update): % %', sqlstate, sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists entity_activity_insert on public.initiative;
create trigger entity_activity_insert
  after insert on public.initiative
  referencing new table as new_rows
  for each statement execute function public.entity_activity_initiative_insert();

drop trigger if exists entity_activity_update on public.initiative;
create trigger entity_activity_update
  after update of name, status, owner_id on public.initiative
  for each row
  when (old.name is distinct from new.name
     or old.status is distinct from new.status
     or old.owner_id is distinct from new.owner_id)
  execute function public.entity_activity_initiative_update();

-- ════════════════════════════════════════════════════════════════════════════
-- Contacts and companies: created by hand (or by an agent), renamed. A sync
-- or an import (calendar_sync, capture_participant, email_sync, member,
-- prospecting, hubspot, import, vcard…) is not activity: it would bury the
-- rest.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.entity_activity_contact_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
begin
  begin
    select * into a from public.entity_activity_actor();
    insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id)
    select n.workspace_id, 'contact', n.id, 'created', a.actor_kind, m.id
      from new_rows n
      left join public.member m on m.user_id = a.actor_user_id and m.workspace_id = n.workspace_id
     where n.workspace_id is not null
       and (n.source is null or n.source = 'manual')
       and n.merged_into_contact_id is null;
  exception when others then
    raise warning 'entity_activity (contact insert): % %', sqlstate, sqlerrm;
  end;
  return null;
end;
$$;

create or replace function public.entity_activity_contact_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
begin
  if new.workspace_id is null then
    return null;
  end if;
  begin
    select * into a from public.entity_activity_actor();
    insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id)
    values (new.workspace_id, 'contact', new.id, 'renamed', a.actor_kind,
            public.entity_activity_member(a.actor_user_id, new.workspace_id));
  exception when others then
    raise warning 'entity_activity (contact update): % %', sqlstate, sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists entity_activity_insert on public.contact;
create trigger entity_activity_insert
  after insert on public.contact
  referencing new table as new_rows
  for each statement execute function public.entity_activity_contact_insert();

drop trigger if exists entity_activity_update on public.contact;
create trigger entity_activity_update
  after update of full_name on public.contact
  for each row
  when (old.full_name is distinct from new.full_name)
  execute function public.entity_activity_contact_update();

create or replace function public.entity_activity_company_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
begin
  begin
    select * into a from public.entity_activity_actor();
    insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id)
    select n.workspace_id, 'company', n.id, 'created', a.actor_kind, m.id
      from new_rows n
      left join public.member m on m.user_id = a.actor_user_id and m.workspace_id = n.workspace_id
     where n.workspace_id is not null and n.source_provider is null;
  exception when others then
    raise warning 'entity_activity (company insert): % %', sqlstate, sqlerrm;
  end;
  return null;
end;
$$;

create or replace function public.entity_activity_company_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
begin
  if new.workspace_id is null then
    return null;
  end if;
  begin
    select * into a from public.entity_activity_actor();
    insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id)
    values (new.workspace_id, 'company', new.id, 'renamed', a.actor_kind,
            public.entity_activity_member(a.actor_user_id, new.workspace_id));
  exception when others then
    raise warning 'entity_activity (company update): % %', sqlstate, sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists entity_activity_insert on public.company;
create trigger entity_activity_insert
  after insert on public.company
  referencing new table as new_rows
  for each statement execute function public.entity_activity_company_insert();

drop trigger if exists entity_activity_update on public.company;
create trigger entity_activity_update
  after update of name on public.company
  for each row
  when (old.name is distinct from new.name)
  execute function public.entity_activity_company_update();

-- ════════════════════════════════════════════════════════════════════════════
-- Deals: created, renamed, status_changed (stage), assigned (owner). The
-- deal's own History (deal_event, with Undo) stays the deal panel's.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.entity_activity_deal_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
begin
  begin
    select * into a from public.entity_activity_actor();
    insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, subject_member_id, detail)
    select n.workspace_id, 'deal', n.id, v.action, a.actor_kind, m.id, v.subject, v.detail
      from new_rows n
      left join public.member m on m.user_id = a.actor_user_id and m.workspace_id = n.workspace_id
      cross join lateral (values
        ('created', null::uuid, '{}'::jsonb, true),
        ('assigned', n.owner_id, jsonb_build_object('from', null, 'to', n.owner_id), n.owner_id is not null)
      ) v(action, subject, detail, hit)
     where v.hit and n.workspace_id is not null;
  exception when others then
    raise warning 'entity_activity (deal insert): % %', sqlstate, sqlerrm;
  end;
  return null;
end;
$$;

create or replace function public.entity_activity_deal_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
begin
  if new.workspace_id is null then
    return null;
  end if;
  begin
    select * into a from public.entity_activity_actor();
    insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, subject_member_id, detail)
    select new.workspace_id, 'deal', new.id, v.action, a.actor_kind,
           public.entity_activity_member(a.actor_user_id, new.workspace_id), v.subject, v.detail
      from (values
        ('renamed', null::uuid, '{}'::jsonb, old.name is distinct from new.name),
        ('status_changed', null::uuid, jsonb_build_object('from', old.stage_id, 'to', new.stage_id), old.stage_id is distinct from new.stage_id),
        ('assigned', new.owner_id, jsonb_build_object('from', old.owner_id, 'to', new.owner_id), old.owner_id is distinct from new.owner_id)
      ) v(action, subject, detail, hit)
     where v.hit;
  exception when others then
    raise warning 'entity_activity (deal update): % %', sqlstate, sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists entity_activity_insert on public.deal;
create trigger entity_activity_insert
  after insert on public.deal
  referencing new table as new_rows
  for each statement execute function public.entity_activity_deal_insert();

drop trigger if exists entity_activity_update on public.deal;
create trigger entity_activity_update
  after update of name, stage_id, owner_id on public.deal
  for each row
  when (old.name is distinct from new.name
     or old.stage_id is distinct from new.stage_id
     or old.owner_id is distinct from new.owner_id)
  execute function public.entity_activity_deal_update();

-- ════════════════════════════════════════════════════════════════════════════
-- Flows (loops): created, renamed, status_changed (switched on or off)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.entity_activity_flow_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
begin
  begin
    select * into a from public.entity_activity_actor();
    insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id)
    select n.workspace_id, 'flow', n.id, 'created', a.actor_kind, m.id
      from new_rows n
      left join public.member m on m.user_id = a.actor_user_id and m.workspace_id = n.workspace_id
     where n.workspace_id is not null;
  exception when others then
    raise warning 'entity_activity (flow insert): % %', sqlstate, sqlerrm;
  end;
  return null;
end;
$$;

create or replace function public.entity_activity_flow_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
begin
  if new.workspace_id is null then
    return null;
  end if;
  begin
    select * into a from public.entity_activity_actor();
    insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, detail)
    select new.workspace_id, 'flow', new.id, v.action, a.actor_kind,
           public.entity_activity_member(a.actor_user_id, new.workspace_id), v.detail
      from (values
        ('renamed', '{}'::jsonb, old.name is distinct from new.name),
        ('status_changed',
          jsonb_build_object('from', case when old.enabled then 'on' else 'off' end, 'to', case when new.enabled then 'on' else 'off' end),
          old.enabled is distinct from new.enabled)
      ) v(action, detail, hit)
     where v.hit;
  exception when others then
    raise warning 'entity_activity (flow update): % %', sqlstate, sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists entity_activity_insert on public.flow;
create trigger entity_activity_insert
  after insert on public.flow
  referencing new table as new_rows
  for each statement execute function public.entity_activity_flow_insert();

drop trigger if exists entity_activity_update on public.flow;
create trigger entity_activity_update
  after update of name, enabled on public.flow
  for each row
  when (old.name is distinct from new.name or old.enabled is distinct from new.enabled)
  execute function public.entity_activity_flow_update();

-- ════════════════════════════════════════════════════════════════════════════
-- Comments: 'commented' on the record commented on (its workspace through
-- that record). The author is the actor.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.entity_activity_comment_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
begin
  begin
    select * into a from public.entity_activity_actor();
    insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, detail)
    select w.workspace_id, n.commentable_type::text, n.commentable_id, 'commented',
           case when n.author_id is not null then 'member' else a.actor_kind end,
           coalesce(n.author_id, m.id),
           jsonb_build_object('comment_id', n.id)
      from new_rows n
      cross join lateral (
        select case n.commentable_type::text
          when 'action' then (select x.workspace_id from public.actions x where x.id = n.commentable_id)
          when 'capture' then (select x.workspace_id from public.captures x where x.id = n.commentable_id and x.is_eval is not true)
          when 'document' then (select x.workspace_id from public.document x where x.id = n.commentable_id)
          when 'project' then (select x.workspace_id from public.projects x where x.id = n.commentable_id)
          when 'contact' then (select x.workspace_id from public.contact x where x.id = n.commentable_id)
        end as workspace_id
      ) w
      left join public.member m on m.user_id = a.actor_user_id and m.workspace_id = w.workspace_id
     where w.workspace_id is not null;
  exception when others then
    raise warning 'entity_activity (comment insert): % %', sqlstate, sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists entity_activity_insert on public.comment;
create trigger entity_activity_insert
  after insert on public.comment
  referencing new table as new_rows
  for each statement execute function public.entity_activity_comment_insert();

-- ════════════════════════════════════════════════════════════════════════════
-- Edges (entity_link): a 'mentions' edge is 'mentioned' on the record it
-- names; one naming a member is 'mentioned' on the source, about that
-- member (the Inbox). Any other relation is 'linked' on both ends. Claims'
-- edges are left out (extraction writes them in bulk; a record's claims
-- have their own panel). Only the logged kinds count.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.entity_activity_entity_link_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
  kinds text[] := array['action', 'document', 'capture', 'project', 'initiative', 'contact', 'company', 'deal', 'flow', 'team_chat_message'];
begin
  begin
    select * into a from public.entity_activity_actor();
    insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, subject_member_id, detail)
    select n.workspace_id, v.entity_type, v.entity_id, v.action,
           case when n.created_by is not null then 'member' else a.actor_kind end,
           coalesce(n.created_by, m.id), v.subject, v.detail
      from new_rows n
      left join public.member m on m.user_id = a.actor_user_id and m.workspace_id = n.workspace_id
      cross join lateral (values
        -- A record mentioned.
        ('mentioned', n.target_type, n.target_id, null::uuid,
          jsonb_build_object('source_type', n.source_type, 'source_id', n.source_id),
          n.relation = 'mentions' and n.target_type = any(kinds)),
        -- A member mentioned: the row is the source's, about them.
        ('mentioned', n.source_type, n.source_id, n.target_id,
          jsonb_build_object('source_type', n.source_type, 'source_id', n.source_id),
          n.relation = 'mentions' and n.target_type = 'member' and n.source_type = any(kinds)),
        -- Linked, on each end.
        ('linked', n.target_type, n.target_id, null::uuid,
          jsonb_build_object('other_type', n.source_type, 'other_id', n.source_id, 'relation', n.relation),
          n.relation <> 'mentions' and n.target_type = any(kinds) and n.source_type = any(kinds)),
        ('linked', n.source_type, n.source_id, null::uuid,
          jsonb_build_object('other_type', n.target_type, 'other_id', n.target_id, 'relation', n.relation),
          n.relation <> 'mentions' and n.target_type = any(kinds) and n.source_type = any(kinds))
      ) v(action, entity_type, entity_id, subject, detail, hit)
     where v.hit
       and n.source_type <> 'claim'
       and n.workspace_id is not null;
  exception when others then
    raise warning 'entity_activity (entity_link insert): % %', sqlstate, sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists entity_activity_insert on public.entity_link;
create trigger entity_activity_insert
  after insert on public.entity_link
  referencing new table as new_rows
  for each statement execute function public.entity_activity_entity_link_insert();

-- ════════════════════════════════════════════════════════════════════════════
-- Team chat: a member @-mentioned in a message ('mentioned' on the message,
-- about them), on post and when an edit adds them. The message's author is
-- the actor; an agent's reply is the agent's, for the member it works for.
-- Messages themselves are not activity (a chat is its own log), and a
-- record a message mentions arrives through its entity_link edge.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.entity_activity_team_chat_message_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, subject_member_id, detail)
    select n.workspace_id, 'team_chat_message', n.id, 'mentioned',
           case when n.author_kind = 'agent' then 'agent' else 'member' end,
           coalesce(n.author_member_id, n.agent_for_member_id), who.member_id,
           jsonb_build_object('channel_id', n.channel_id)
      from new_rows n
      cross join lateral unnest(coalesce(n.mentions, '{}'::uuid[])) as who(member_id)
     where n.deleted_at is null
       and n.workspace_id is not null
       and who.member_id is distinct from n.author_member_id;
  exception when others then
    raise warning 'entity_activity (team_chat_message insert): % %', sqlstate, sqlerrm;
  end;
  return null;
end;
$$;

create or replace function public.entity_activity_team_chat_message_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.deleted_at is not null or new.workspace_id is null then
    return null;
  end if;
  begin
    insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, subject_member_id, detail)
    select new.workspace_id, 'team_chat_message', new.id, 'mentioned',
           case when new.author_kind = 'agent' then 'agent' else 'member' end,
           coalesce(new.author_member_id, new.agent_for_member_id), who.member_id,
           jsonb_build_object('channel_id', new.channel_id)
      from unnest(coalesce(new.mentions, '{}'::uuid[])) as who(member_id)
     where not (who.member_id = any(coalesce(old.mentions, '{}'::uuid[])))
       and who.member_id is distinct from new.author_member_id;
  exception when others then
    raise warning 'entity_activity (team_chat_message update): % %', sqlstate, sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists entity_activity_insert on public.team_chat_message;
create trigger entity_activity_insert
  after insert on public.team_chat_message
  referencing new table as new_rows
  for each statement execute function public.entity_activity_team_chat_message_insert();

drop trigger if exists entity_activity_update on public.team_chat_message;
create trigger entity_activity_update
  after update of mentions on public.team_chat_message
  for each row
  when (old.mentions is distinct from new.mentions and new.deleted_at is null)
  execute function public.entity_activity_team_chat_message_update();

-- The trigger functions run only as triggers.
revoke all on function public.entity_activity_actions_insert() from public, anon, authenticated;
revoke all on function public.entity_activity_actions_update() from public, anon, authenticated;
revoke all on function public.entity_activity_document_insert() from public, anon, authenticated;
revoke all on function public.entity_activity_document_update() from public, anon, authenticated;
revoke all on function public.entity_activity_captures_insert() from public, anon, authenticated;
revoke all on function public.entity_activity_captures_update() from public, anon, authenticated;
revoke all on function public.entity_activity_projects_insert() from public, anon, authenticated;
revoke all on function public.entity_activity_projects_update() from public, anon, authenticated;
revoke all on function public.entity_activity_initiative_insert() from public, anon, authenticated;
revoke all on function public.entity_activity_initiative_update() from public, anon, authenticated;
revoke all on function public.entity_activity_contact_insert() from public, anon, authenticated;
revoke all on function public.entity_activity_contact_update() from public, anon, authenticated;
revoke all on function public.entity_activity_company_insert() from public, anon, authenticated;
revoke all on function public.entity_activity_company_update() from public, anon, authenticated;
revoke all on function public.entity_activity_deal_insert() from public, anon, authenticated;
revoke all on function public.entity_activity_deal_update() from public, anon, authenticated;
revoke all on function public.entity_activity_flow_insert() from public, anon, authenticated;
revoke all on function public.entity_activity_flow_update() from public, anon, authenticated;
revoke all on function public.entity_activity_comment_insert() from public, anon, authenticated;
revoke all on function public.entity_activity_entity_link_insert() from public, anon, authenticated;
revoke all on function public.entity_activity_team_chat_message_insert() from public, anon, authenticated;
revoke all on function public.entity_activity_team_chat_message_update() from public, anon, authenticated;
