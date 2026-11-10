-- ============================================================
-- 489: the activity log (488), hardened after review.
-- ============================================================
-- What changes, and why (each was shown on DEV inside a rolled-back
-- transaction before this file was written):
--
--   1. Reading the log follows the record. 488's policy let any member of
--      the workspace read every row through the REST API, so a member saw
--      that another member's private capture or document exists, when it
--      was renamed or archived and by whom, and who @-mentioned whom in a
--      DM they aren't in. A row is now readable only when the viewer can
--      read the record it is about AND the record its detail names (who
--      mentioned it, what it was linked to), each through that record's
--      own table and its own RLS (the policy's probes). The feed's
--      re-checks (src/lib/entities/feed.ts) stay, as a second fence.
--
--   2. Only the service role can name an agent. 488 trusted the
--      x-activity-* headers whenever auth.uid() was null, which an
--      anonymous request (the anon key, no session) also is. The headers
--      now count only on a request whose JWT role is service_role.
--
--   3. An edge's or a comment's author is the signed-in caller. entity_link's
--      RLS is "a member of the workspace" and does not fence created_by, so
--      a member could write an edge naming another member as its author and
--      the log credited them ("Maya mentioned you"). A signed-in request is
--      now always credited to its own member; the row's created_by /
--      author_id counts only for a server request that names nobody.
--
--   4. A move carries the record's history. A record moved to another
--      workspace (the move engine, 221) kept its old rows under the old
--      workspace (lost to the new one's members) while the move's own
--      remaps (states, assignees) were logged as new changes. A change of
--      workspace_id now re-stamps the record's rows and logs nothing else.
--
--   5. A merge (402) is not activity. Its re-pointing of assignees, owners
--      and states would have written an "Assigned to you" for every task a
--      folded member held. Inside a merge (dial8.workspace_merge set) the
--      triggers do nothing; the merge's generic re-stamp carries the rows.
--
--   6. No subtransaction per row. 488 wrapped every trigger body in
--      BEGIN … EXCEPTION, which opens a subtransaction each time it runs;
--      on a row-level trigger a bulk update of n rows opened n of them, and
--      past 64 in one transaction Postgres overflows its subtransaction
--      cache (a slowdown for every session's snapshots). The bodies are now
--      plain and defensive instead: nothing they write can violate a
--      constraint (fixed actions and kinds, objects built by
--      jsonb_build_object), the request headers are parsed only when
--      pg_input_is_valid says they are JSON, and every insert first checks
--      that the row's workspace still exists, so a workspace deleted in the
--      same transaction (its members' ON DELETE SET NULL fires the update
--      triggers mid-cascade) is skipped instead of failing the foreign key.
--
-- Idempotent (create or replace, drop … if exists). No backslashes.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- ── 2. Who did it ───────────────────────────────────────────────────────────
create or replace function public.entity_activity_actor(out actor_kind text, out actor_user_id uuid)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  claims text := nullif(current_setting('request.jwt.claims', true), '');
  jwt_role text;
  raw text;
  h jsonb;
  u text;
begin
  actor_user_id := auth.uid();
  if actor_user_id is not null then
    actor_kind := 'member';
    return;
  end if;
  actor_kind := 'system';
  if claims is not null and pg_input_is_valid(claims, 'jsonb') then
    jwt_role := claims::jsonb ->> 'role';
  end if;
  jwt_role := coalesce(jwt_role, nullif(current_setting('request.jwt.claim.role', true), ''));
  if jwt_role is distinct from 'service_role' then
    return;
  end if;
  raw := nullif(current_setting('request.headers', true), '');
  if raw is null or not pg_input_is_valid(raw, 'jsonb') then
    return;
  end if;
  h := raw::jsonb;
  if jsonb_typeof(h) = 'object' and h ->> 'x-activity-actor' = 'agent' then
    actor_kind := 'agent';
    u := h ->> 'x-activity-user';
    if u is not null and pg_input_is_valid(u, 'uuid') then
      actor_user_id := u::uuid;
    end if;
  end if;
end;
$$;

revoke all on function public.entity_activity_actor() from public, anon, authenticated;

-- Whether the log may be written for a workspace now: not inside a merge,
-- and the workspace still there (not deleted earlier in this transaction).
create or replace function public.entity_activity_writable(p_workspace uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select p_workspace is not null
     and coalesce(current_setting('dial8.workspace_merge', true), '') = ''
     and exists (select 1 from public.workspace w where w.id = p_workspace);
$$;

revoke all on function public.entity_activity_writable(uuid) from public, anon, authenticated;

-- A record moved to another workspace: its history goes with it.
create or replace function public.entity_activity_follow(p_type text, p_id uuid, p_from uuid, p_to uuid)
returns void
language sql
volatile
set search_path = public, pg_temp
as $$
  update public.entity_activity
     set workspace_id = p_to
   where entity_type = p_type
     and entity_id = p_id
     and workspace_id is not distinct from p_from
     and public.entity_activity_writable(p_to);
$$;

revoke all on function public.entity_activity_follow(text, uuid, uuid, uuid) from public, anon, authenticated;

-- ── 1. Reading follows the record ───────────────────────────────────────────
-- The policy runs as the reader: each probe below reads that table under the
-- reader's own RLS, so "can see the row" is exactly "can read the record".
-- Only the kinds with a per-record rule are probed: a document or capture
-- (private to its maker), a contact (its visibility, can_view_contact), a
-- company (through its contacts) and a team-chat message (its channel,
-- team_chat_can_read). Every other logged kind (task, project, initiative,
-- deal, loop) is readable by every member of its workspace, which the first
-- clause checks; a kind that gains a per-record rule must join the probed
-- list (src/lib/entities/__tests__/migration-489.test.ts holds both lists).
-- The other record a row's detail names (who mentioned it, what it was
-- linked to) is probed the same way. The probes are written into the policy
-- itself, not a function: a function holding a subquery is never inlined,
-- and a call per row made the planner give up the (workspace_id, created_at)
-- index order (measured on DEV: 6 ms against 245 ms for a 400-row page).
-- Each probe ends in OFFSET 0, which keeps it a per-row primary-key lookup:
-- without it the planner may turn the EXISTS into a hashed subplan, which
-- reads every row of the probed table the reader can see, once per query
-- (a whole contact table, for a 20-row page).

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
      else false
    end
  );

-- ════════════════════════════════════════════════════════════════════════════
-- The trigger bodies, without the per-row subtransaction (6), with the merge
-- skip (5), the move re-stamp (4) and the caller as author (3). What each one
-- logs is 488's, unchanged.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Tasks ───────────────────────────────────────────────────────────────────
create or replace function public.entity_activity_actions_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
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
     and n.confirmation is distinct from 'suggested'
     and public.entity_activity_writable(n.workspace_id);
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
  if old.workspace_id is distinct from new.workspace_id then
    perform public.entity_activity_follow('action', new.id, old.workspace_id, new.workspace_id);
    return null;
  end if;
  if new.confirmation = 'suggested' or not public.entity_activity_writable(new.workspace_id) then
    return null;
  end if;
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
  return null;
end;
$$;

drop trigger if exists entity_activity_update on public.actions;
create trigger entity_activity_update
  after update of title, status_id, assignee_id, confirmation, workspace_id on public.actions
  for each row
  when (old.title is distinct from new.title
     or old.status_id is distinct from new.status_id
     or old.assignee_id is distinct from new.assignee_id
     or old.confirmation is distinct from new.confirmation
     or old.workspace_id is distinct from new.workspace_id)
  execute function public.entity_activity_actions_update();

-- ── Documents ───────────────────────────────────────────────────────────────
create or replace function public.entity_activity_document_insert()
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
  select n.workspace_id, 'document', n.id, 'created', a.actor_kind, m.id
    from new_rows n
    left join public.member m on m.user_id = a.actor_user_id and m.workspace_id = n.workspace_id
   where public.entity_activity_writable(n.workspace_id);
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
  if old.workspace_id is distinct from new.workspace_id then
    perform public.entity_activity_follow('document', new.id, old.workspace_id, new.workspace_id);
    return null;
  end if;
  if not public.entity_activity_writable(new.workspace_id) then
    return null;
  end if;
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
  return null;
end;
$$;

drop trigger if exists entity_activity_update on public.document;
create trigger entity_activity_update
  after update of title, status, workspace_id on public.document
  for each row
  when (old.title is distinct from new.title
     or old.status is distinct from new.status
     or old.workspace_id is distinct from new.workspace_id)
  execute function public.entity_activity_document_update();

-- ── Captures ────────────────────────────────────────────────────────────────
create or replace function public.entity_activity_captures_insert()
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
  select n.workspace_id, 'capture', n.id, 'created', a.actor_kind, m.id
    from new_rows n
    left join public.member m on m.user_id = a.actor_user_id and m.workspace_id = n.workspace_id
   where n.is_eval is not true
     and public.entity_activity_writable(n.workspace_id);
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
  if old.workspace_id is distinct from new.workspace_id then
    perform public.entity_activity_follow('capture', new.id, old.workspace_id, new.workspace_id);
    return null;
  end if;
  if new.is_eval is true or not public.entity_activity_writable(new.workspace_id) then
    return null;
  end if;
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
  return null;
end;
$$;

drop trigger if exists entity_activity_update on public.captures;
create trigger entity_activity_update
  after update of title, status, workspace_id on public.captures
  for each row
  when (old.title is distinct from new.title
     or (old.status = 'archived') is distinct from (new.status = 'archived')
     or old.workspace_id is distinct from new.workspace_id)
  execute function public.entity_activity_captures_update();

-- ── Projects ────────────────────────────────────────────────────────────────
create or replace function public.entity_activity_projects_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
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
   where v.hit and public.entity_activity_writable(n.workspace_id);
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
  if old.workspace_id is distinct from new.workspace_id then
    perform public.entity_activity_follow('project', new.id, old.workspace_id, new.workspace_id);
    return null;
  end if;
  if not public.entity_activity_writable(new.workspace_id) then
    return null;
  end if;
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
  return null;
end;
$$;

drop trigger if exists entity_activity_update on public.projects;
create trigger entity_activity_update
  after update of name, status, lead_id, is_archived, workspace_id on public.projects
  for each row
  when (old.name is distinct from new.name
     or old.status is distinct from new.status
     or old.lead_id is distinct from new.lead_id
     or old.is_archived is distinct from new.is_archived
     or old.workspace_id is distinct from new.workspace_id)
  execute function public.entity_activity_projects_update();

-- ── Initiatives ─────────────────────────────────────────────────────────────
create or replace function public.entity_activity_initiative_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
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
   where v.hit and public.entity_activity_writable(n.workspace_id);
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
  if old.workspace_id is distinct from new.workspace_id then
    perform public.entity_activity_follow('initiative', new.id, old.workspace_id, new.workspace_id);
    return null;
  end if;
  if not public.entity_activity_writable(new.workspace_id) then
    return null;
  end if;
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
  return null;
end;
$$;

drop trigger if exists entity_activity_update on public.initiative;
create trigger entity_activity_update
  after update of name, status, owner_id, workspace_id on public.initiative
  for each row
  when (old.name is distinct from new.name
     or old.status is distinct from new.status
     or old.owner_id is distinct from new.owner_id
     or old.workspace_id is distinct from new.workspace_id)
  execute function public.entity_activity_initiative_update();

-- ── Contacts and companies ──────────────────────────────────────────────────
create or replace function public.entity_activity_contact_insert()
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
  select n.workspace_id, 'contact', n.id, 'created', a.actor_kind, m.id
    from new_rows n
    left join public.member m on m.user_id = a.actor_user_id and m.workspace_id = n.workspace_id
   where (n.source is null or n.source = 'manual')
     and n.merged_into_contact_id is null
     and public.entity_activity_writable(n.workspace_id);
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
  if old.workspace_id is distinct from new.workspace_id then
    perform public.entity_activity_follow('contact', new.id, old.workspace_id, new.workspace_id);
    return null;
  end if;
  if old.full_name is not distinct from new.full_name or not public.entity_activity_writable(new.workspace_id) then
    return null;
  end if;
  select * into a from public.entity_activity_actor();
  insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id)
  values (new.workspace_id, 'contact', new.id, 'renamed', a.actor_kind,
          public.entity_activity_member(a.actor_user_id, new.workspace_id));
  return null;
end;
$$;

drop trigger if exists entity_activity_update on public.contact;
create trigger entity_activity_update
  after update of full_name, workspace_id on public.contact
  for each row
  when (old.full_name is distinct from new.full_name
     or old.workspace_id is distinct from new.workspace_id)
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
  select * into a from public.entity_activity_actor();
  insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id)
  select n.workspace_id, 'company', n.id, 'created', a.actor_kind, m.id
    from new_rows n
    left join public.member m on m.user_id = a.actor_user_id and m.workspace_id = n.workspace_id
   where n.source_provider is null
     and public.entity_activity_writable(n.workspace_id);
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
  if old.workspace_id is distinct from new.workspace_id then
    perform public.entity_activity_follow('company', new.id, old.workspace_id, new.workspace_id);
    return null;
  end if;
  if old.name is not distinct from new.name or not public.entity_activity_writable(new.workspace_id) then
    return null;
  end if;
  select * into a from public.entity_activity_actor();
  insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id)
  values (new.workspace_id, 'company', new.id, 'renamed', a.actor_kind,
          public.entity_activity_member(a.actor_user_id, new.workspace_id));
  return null;
end;
$$;

drop trigger if exists entity_activity_update on public.company;
create trigger entity_activity_update
  after update of name, workspace_id on public.company
  for each row
  when (old.name is distinct from new.name
     or old.workspace_id is distinct from new.workspace_id)
  execute function public.entity_activity_company_update();

-- ── Deals ───────────────────────────────────────────────────────────────────
create or replace function public.entity_activity_deal_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
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
   where v.hit and public.entity_activity_writable(n.workspace_id);
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
  if old.workspace_id is distinct from new.workspace_id then
    perform public.entity_activity_follow('deal', new.id, old.workspace_id, new.workspace_id);
    return null;
  end if;
  if not public.entity_activity_writable(new.workspace_id) then
    return null;
  end if;
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
  return null;
end;
$$;

drop trigger if exists entity_activity_update on public.deal;
create trigger entity_activity_update
  after update of name, stage_id, owner_id, workspace_id on public.deal
  for each row
  when (old.name is distinct from new.name
     or old.stage_id is distinct from new.stage_id
     or old.owner_id is distinct from new.owner_id
     or old.workspace_id is distinct from new.workspace_id)
  execute function public.entity_activity_deal_update();

-- ── Flows ───────────────────────────────────────────────────────────────────
create or replace function public.entity_activity_flow_insert()
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
  select n.workspace_id, 'flow', n.id, 'created', a.actor_kind, m.id
    from new_rows n
    left join public.member m on m.user_id = a.actor_user_id and m.workspace_id = n.workspace_id
   where public.entity_activity_writable(n.workspace_id);
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
  if old.workspace_id is distinct from new.workspace_id then
    perform public.entity_activity_follow('flow', new.id, old.workspace_id, new.workspace_id);
    return null;
  end if;
  if not public.entity_activity_writable(new.workspace_id) then
    return null;
  end if;
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
  return null;
end;
$$;

drop trigger if exists entity_activity_update on public.flow;
create trigger entity_activity_update
  after update of name, enabled, workspace_id on public.flow
  for each row
  when (old.name is distinct from new.name
     or old.enabled is distinct from new.enabled
     or old.workspace_id is distinct from new.workspace_id)
  execute function public.entity_activity_flow_update();

-- ── Comments: the signed-in caller is the author (3) ────────────────────────
create or replace function public.entity_activity_comment_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
begin
  select * into a from public.entity_activity_actor();
  insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, detail)
  select w.workspace_id, n.commentable_type::text, n.commentable_id, 'commented',
         case when a.actor_kind = 'system' and n.author_id is not null then 'member' else a.actor_kind end,
         case when a.actor_kind = 'system' then n.author_id else m.id end,
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
   where n.commentable_id is not null
     and public.entity_activity_writable(w.workspace_id);
  return null;
end;
$$;

-- ── Edges: the signed-in caller is the author (3) ───────────────────────────
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

-- ── Team chat (its insert RLS already pins the author to the caller) ────────
create or replace function public.entity_activity_team_chat_message_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, subject_member_id, detail)
  select n.workspace_id, 'team_chat_message', n.id, 'mentioned',
         case when n.author_kind = 'agent' then 'agent' else 'member' end,
         coalesce(n.author_member_id, n.agent_for_member_id), who.member_id,
         jsonb_build_object('channel_id', n.channel_id)
    from new_rows n
    cross join lateral unnest(coalesce(n.mentions, '{}'::uuid[])) as who(member_id)
   where n.deleted_at is null
     and who.member_id is not null
     and who.member_id is distinct from n.author_member_id
     and public.entity_activity_writable(n.workspace_id);
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
  if new.deleted_at is not null or not public.entity_activity_writable(new.workspace_id) then
    return null;
  end if;
  insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, subject_member_id, detail)
  select new.workspace_id, 'team_chat_message', new.id, 'mentioned',
         case when new.author_kind = 'agent' then 'agent' else 'member' end,
         coalesce(new.author_member_id, new.agent_for_member_id), who.member_id,
         jsonb_build_object('channel_id', new.channel_id)
    from unnest(coalesce(new.mentions, '{}'::uuid[])) as who(member_id)
   where who.member_id is not null
     and not (who.member_id = any(coalesce(old.mentions, '{}'::uuid[])))
     and who.member_id is distinct from new.author_member_id;
  return null;
end;
$$;

-- The trigger functions run only as triggers (488 revoked them; restated).
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
