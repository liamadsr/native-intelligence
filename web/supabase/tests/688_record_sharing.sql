-- DB-level test for migration 688 (record sharing): a private spreadsheet
-- or canvas shared with people, as view or edit, and what a grant never
-- opens. The TS test (src/lib/entity-access/__tests__/migration-688.test.ts)
-- pins the file's text; this runs the rules as several people, under RLS.
--
-- Run against a database with the migrations applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/688_record_sharing.sql
-- Prints a PASS or FAIL line a check, then "688 record_sharing: all checks
-- passed", or raises naming the failed checks. Everything runs in one
-- transaction that is rolled back. Made-up people only (example.test).
-- The spreadsheet presence checks need 689 (spreadsheet presence); without
-- it they are skipped, and say so.
--
-- People, in one workspace: A owns the records; B, C and D are members (D is
-- in team Design); G is a guest; X is an admin. E is in another workspace.
\set ON_ERROR_STOP 1
set client_min_messages = notice;

begin;

create schema rh;
grant usage on schema rh to authenticated, anon, service_role;
create table rh.people (name text primary key, user_id uuid not null, member_id uuid);
grant select on rh.people to authenticated, service_role;
create table rh.ids (name text primary key, id uuid not null);
grant select on rh.ids to authenticated, service_role;
create table rh.results (n serial, label text, ok boolean);
grant insert, select on rh.results to authenticated, service_role;
grant usage on sequence rh.results_n_seq to authenticated, service_role;

create function rh.u(p text) returns uuid language sql stable as $$ select user_id from rh.people where name = p $$;
create function rh.m(p text) returns uuid language sql stable as $$ select member_id from rh.people where name = p $$;
create function rh.id(p text) returns uuid language sql stable as $$ select id from rh.ids where name = p $$;
grant execute on all functions in schema rh to authenticated, service_role;

-- Act as someone: the JWT claims Supabase sets, and the authenticated role.
create function rh.as_(p text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', rh.u(p), 'role', 'authenticated')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
-- Run a statement as the current role: its row count, or ERR <sqlstate>.
-- The service role, for no one in particular (the agent's tool proxies): no auth.uid().
create function rh.as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, false);
  perform set_config('role', 'service_role', false);
end $$;
create function rh.try(q text) returns text language plpgsql as $$
declare n int;
begin
  execute q;
  get diagnostics n = row_count;
  return n::text;
exception when others then
  return 'ERR ' || sqlstate;
end $$;
create function rh.has_689() returns boolean language sql stable as $$
  select exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'spreadsheet_presence_hear') $$;
create function rh.ok(cond boolean, label text) returns void language plpgsql as $$
begin
  insert into rh.results (label, ok) values (label, coalesce(cond, false));
  if coalesce(cond, false) then raise notice 'PASS  %', label; else raise notice 'FAIL  %', label; end if;
end $$;
grant execute on all functions in schema rh to authenticated, service_role;

-- ── Setup, as postgres ──────────────────────────────────────────────────────
insert into auth.users (email) select n || '@example.test' from unnest(array['a','b','c','d','g','x','e']) n;
insert into rh.people (name, user_id) select upper(split_part(email, '@', 1)), id from auth.users where email like '%@example.test';

insert into public.workspace (name, slug) values ('Rehearsal', 'rehearsal-688'), ('Elsewhere', 'elsewhere-688');
insert into rh.ids select 'W', id from public.workspace where slug = 'rehearsal-688';
insert into rh.ids select 'W2', id from public.workspace where slug = 'elsewhere-688';

insert into public.member (user_id, workspace_id, display_name, role)
select rh.u(p), rh.id('W'), p, r from (values ('A','member'),('B','member'),('C','member'),('D','member'),('G','guest'),('X','admin')) v(p, r);
insert into public.member (user_id, workspace_id, display_name, role) values (rh.u('E'), rh.id('W2'), 'E', 'member');
update rh.people p set member_id = m.id from public.member m where m.user_id = p.user_id;

insert into public.team (workspace_id, name, slug, issue_prefix) values (rh.id('W'), 'Design', 'design-688', 'DSN');
insert into rh.ids select 'T', id from public.team where slug = 'design-688';
insert into public.team_member (team_id, member_id) values (rh.id('T'), rh.m('D'));

insert into public.spreadsheet (workspace_id, title, created_by, visibility) values (rh.id('W'), 'Private plan', rh.m('A'), 'private');
insert into rh.ids select 'S', id from public.spreadsheet where title = 'Private plan';
insert into public.spreadsheet (workspace_id, title, created_by, visibility) values (rh.id('W'), 'Open plan', rh.m('A'), 'workspace');
insert into rh.ids select 'S_open', id from public.spreadsheet where title = 'Open plan';
insert into public.spreadsheet_comment (spreadsheet_id, workspace_id, body, author_id) values (rh.id('S'), rh.id('W'), 'owner note', rh.m('A'));
insert into rh.ids select 'S_comment', id from public.spreadsheet_comment where body = 'owner note';

insert into public.canvas (workspace_id, title, owner_member_id, created_by_user_id, visibility) values (rh.id('W'), 'Private board', rh.m('A'), rh.u('A'), 'private');
insert into rh.ids select 'C', id from public.canvas where title = 'Private board';
insert into public.canvas_item (canvas_id, workspace_id, id, sort_key, kind, data) values (rh.id('C'), rh.id('W'), 'i1', 'a0', 'rectangle', '{}');
insert into public.canvas_comment (canvas_id, workspace_id, body, author_id) values (rh.id('C'), rh.id('W'), 'owner note', rh.m('A'));
insert into rh.ids select 'C_comment', id from public.canvas_comment where canvas_id = rh.id('C');

-- Presence rows, as Realtime's own authorisation reads them.
insert into realtime.messages (topic, extension, payload) values ('canvas-presence:' || rh.id('C'), 'broadcast', '{}');
insert into realtime.messages (topic, extension, payload) values ('spreadsheet-presence:' || rh.id('S'), 'broadcast', '{}');

-- ── 1. Before any grant: C and B see nothing ────────────────────────────────
select rh.as_('B');
select rh.ok((select count(*) from public.spreadsheet where id = rh.id('S')) = 0, 'no grant: B does not read the private spreadsheet');
select rh.ok((select count(*) from public.canvas where id = rh.id('C')) = 0, 'no grant: B does not read the private canvas');
select rh.ok((select count(*) from public.canvas_item where canvas_id = rh.id('C')) = 0, 'no grant: B reads no items');
select rh.ok(set_config('realtime.topic', 'canvas-presence:' || rh.id('C'), false) is not null
  and (select count(*) from realtime.messages where topic = 'canvas-presence:' || rh.id('C')) = 0, 'no grant: B cannot hear presence');
select rh.ok(rh.try(format($q$insert into realtime.messages (topic, extension, payload) values ('canvas-presence:%s', 'broadcast', '{}')$q$, rh.id('C'))) like 'ERR%', 'no grant: B cannot speak on presence');
select rh.ok(not public.canvas_visible_to(rh.id('C'), rh.u('B')), 'no grant: canvas_visible_to says no');
select case when rh.has_689() then rh.ok(set_config('realtime.topic', 'spreadsheet-presence:' || rh.id('S'), false) is not null
  and (select count(*) from realtime.messages where topic = 'spreadsheet-presence:' || rh.id('S')) = 0, 'no grant: B cannot hear spreadsheet presence (689)')::text else 'skipped (no 689): spreadsheet presence' end as presence_check;
reset role;

-- ── 2. Who may share ────────────────────────────────────────────────────────
select rh.as_('B');
select rh.ok(rh.try(format($q$insert into public.entity_access (workspace_id, entity_type, entity_id, grantee_kind, grantee_member_id, level, granted_by) values ('%s','spreadsheet','%s','member','%s','view', (select public.current_member_id(rh.id('W'))))$q$, rh.id('W'), rh.id('S'), rh.m('B'))) like 'ERR%', 'B cannot grant themself a spreadsheet');
reset role;
select rh.as_('X');
select rh.ok(rh.try(format($q$insert into public.entity_access (workspace_id, entity_type, entity_id, grantee_kind, grantee_member_id, level, granted_by) values ('%s','canvas','%s','member','%s','view', (select public.current_member_id(rh.id('W'))))$q$, rh.id('W'), rh.id('C'), rh.m('X'))) like 'ERR%', 'an admin cannot share someone else''s private canvas');
select rh.ok((select count(*) from public.canvas where id = rh.id('C')) = 0, 'an admin without a grant does not read a private canvas');
reset role;
select rh.as_('A');
select rh.ok(rh.try(format($q$insert into public.entity_access (workspace_id, entity_type, entity_id, grantee_kind, grantee_member_id, level, granted_by) values ('%s','spreadsheet','%s','member','%s','view', (select public.current_member_id(rh.id('W'))))$q$, rh.id('W2'), rh.id('S'), rh.m('E'))) like 'ERR%', 'a grant across workspaces is refused');
select rh.ok(rh.try(format($q$insert into public.entity_access (workspace_id, entity_type, entity_id, grantee_kind, grantee_member_id, level, granted_by) values ('%s','spreadsheet','%s','member','%s','view', (select public.current_member_id(rh.id('W'))))$q$, rh.id('W'), rh.id('S'), rh.m('E'))) like 'ERR%', 'a grant to another workspace''s member is refused');
select rh.ok(rh.try(format($q$insert into public.entity_access (workspace_id, entity_type, entity_id, grantee_kind, grantee_member_id, level, granted_by) values ('%s','spreadsheet','%s','member','%s','view', (select public.current_member_id(rh.id('W'))))$q$, rh.id('W'), rh.id('S'), rh.m('B'))) = '1', 'A shares the spreadsheet with B (view)');
select rh.ok(rh.try(format($q$insert into public.entity_access (workspace_id, entity_type, entity_id, grantee_kind, grantee_member_id, level, granted_by) values ('%s','canvas','%s','member','%s','view', (select public.current_member_id(rh.id('W'))))$q$, rh.id('W'), rh.id('C'), rh.m('B'))) = '1', 'A shares the canvas with B (view)');
select rh.ok((select count(*) from public.entity_access where entity_id in (rh.id('S'), rh.id('C'))) = 2, 'A lists the two grants');
reset role;

-- ── 3. A view grant: B reads, writes nothing ────────────────────────────────
select rh.as_('B');
select rh.ok((select count(*) from public.spreadsheet where id = rh.id('S')) = 1, 'view: B reads the spreadsheet');
select rh.ok((select count(*) from public.spreadsheet_revision where spreadsheet_id = rh.id('S')) >= 1, 'view: B reads its history');
select rh.ok((select count(*) from public.spreadsheet_comment where spreadsheet_id = rh.id('S')) = 1, 'view: B reads its threads');
select rh.ok(rh.try(format($q$update public.spreadsheet set title = 'B was here' where id = '%s'$q$, rh.id('S'))) = '0', 'view: B cannot edit the spreadsheet');
select rh.ok(rh.try(format($q$insert into public.spreadsheet_comment (spreadsheet_id, workspace_id, body, author_id) values ('%s','%s','hi','%s')$q$, rh.id('S'), rh.id('W'), rh.m('B'))) like 'ERR%', 'view: B cannot comment on the spreadsheet');
select rh.ok(rh.try(format($q$update public.spreadsheet_comment set resolved_at = now(), resolved_by = '%s' where id = '%s'$q$, rh.m('B'), rh.id('S_comment'))) = '0', 'view: B cannot resolve a spreadsheet thread');
select rh.ok((select count(*) from public.canvas where id = rh.id('C')) = 1, 'view: B reads the canvas');
select rh.ok((select count(*) from public.canvas_item where canvas_id = rh.id('C')) = 1, 'view: B reads its items');
select rh.ok((select count(*) from public.canvas_comment where canvas_id = rh.id('C')) = 1, 'view: B reads its comments');
select rh.ok(rh.try(format($q$update public.canvas_item set data = '{"x":1}' where canvas_id = '%s'$q$, rh.id('C'))) = '0', 'view: B cannot edit items');
select rh.ok(rh.try(format($q$insert into public.canvas_item (canvas_id, workspace_id, id, sort_key, kind, data) values ('%s','%s','b1','b0','text','{}')$q$, rh.id('C'), rh.id('W'))) like 'ERR%', 'view: B cannot add items');
select rh.ok(rh.try(format($q$update public.canvas set title = 'B was here' where id = '%s'$q$, rh.id('C'))) = '0', 'view: B cannot rename the canvas');
select rh.ok(rh.try(format($q$insert into public.canvas_comment (canvas_id, workspace_id, body, author_id) values ('%s','%s','hi','%s')$q$, rh.id('C'), rh.id('W'), rh.m('B'))) like 'ERR%', 'view: B cannot comment on the canvas');
select rh.ok(set_config('realtime.topic', 'canvas-presence:' || rh.id('C'), false) is not null
  and (select count(*) from realtime.messages where topic = 'canvas-presence:' || rh.id('C')) = 1, 'view: B hears presence');
select rh.ok(rh.try(format($q$insert into realtime.messages (topic, extension, payload) values ('canvas-presence:%s', 'broadcast', '{}')$q$, rh.id('C'))) = '1', 'view: B speaks on presence (cursor)');
select rh.ok(public.canvas_visible_to(rh.id('C'), rh.u('B')) and not public.canvas_editable_by(rh.id('C'), rh.u('B')), 'view: canvas_visible_to yes, canvas_editable_by no');
select rh.ok(public.spreadsheet_visible_to(rh.id('S'), rh.u('B')) and not public.spreadsheet_editable_by(rh.id('S'), rh.u('B')), 'view: spreadsheet_visible_to yes, spreadsheet_editable_by no');
select rh.ok(public.spreadsheet_entity_visible_to(rh.id('S'), null, rh.u('B')), 'view: spreadsheet_entity_visible_to (links, presence) yes');
select case when rh.has_689() then rh.ok(set_config('realtime.topic', 'spreadsheet-presence:' || rh.id('S'), false) is not null
  and (select count(*) from realtime.messages where topic = 'spreadsheet-presence:' || rh.id('S')) = 1, 'view: B hears spreadsheet presence (689)')::text else 'skipped (no 689): spreadsheet presence' end as presence_check;
select rh.ok(rh.try(format($q$insert into public.entity_access (workspace_id, entity_type, entity_id, grantee_kind, grantee_member_id, level, granted_by) values ('%s','canvas','%s','member','%s','view', (select public.current_member_id(rh.id('W'))))$q$, rh.id('W'), rh.id('C'), rh.m('C'))) like 'ERR%', 'view: B cannot share it on');
select rh.ok(rh.try(format($q$delete from public.canvas where id = '%s'$q$, rh.id('C'))) = '0', 'view: B cannot delete the canvas');
reset role;
-- C still sees nothing
select rh.as_('C');
select rh.ok((select count(*) from public.spreadsheet where id = rh.id('S')) + (select count(*) from public.canvas where id = rh.id('C'))
  + (select count(*) from public.spreadsheet_comment where spreadsheet_id = rh.id('S')) + (select count(*) from public.spreadsheet_revision where spreadsheet_id = rh.id('S'))
  + (select count(*) from public.canvas_comment where canvas_id = rh.id('C')) + (select count(*) from public.canvas_item where canvas_id = rh.id('C')) = 0,
  'C, with no grant, sees nothing on either (rows, items, comments, history)');
select rh.ok((select count(*) from public.entity_access where entity_id in (rh.id('S'), rh.id('C'))) = 0, 'C does not see who it is shared with');
reset role;

-- ── 4. An edit grant: content yes, the record's place no ────────────────────
select rh.as_('A');
select rh.ok(rh.try(format($q$update public.entity_access set level = 'edit' where entity_id in ('%s','%s') and grantee_member_id = '%s'$q$, rh.id('S'), rh.id('C'), rh.m('B'))) = '2', 'A raises B to edit on both');
reset role;
select rh.as_('B');
select rh.ok(rh.try(format($q$update public.spreadsheet set title = 'Plan, by B' where id = '%s'$q$, rh.id('S'))) = '1', 'edit: B edits the spreadsheet');
select rh.ok(rh.try(format($q$insert into public.spreadsheet_comment (spreadsheet_id, workspace_id, body, author_id) values ('%s','%s','hi from B','%s')$q$, rh.id('S'), rh.id('W'), rh.m('B'))) = '1', 'edit: B comments on the spreadsheet');
select rh.ok(rh.try(format($q$update public.spreadsheet set visibility = 'workspace' where id = '%s'$q$, rh.id('S'))) like 'ERR%', 'edit: B cannot change who sees the spreadsheet');
select rh.ok(rh.try(format($q$update public.spreadsheet set status = 'archived' where id = '%s'$q$, rh.id('S'))) like 'ERR%', 'edit: B cannot archive the spreadsheet');
select rh.ok(rh.try(format($q$update public.spreadsheet set created_by = '%s' where id = '%s'$q$, rh.m('B'), rh.id('S'))) like 'ERR%', 'edit: B cannot take the spreadsheet over');
select rh.ok(rh.try(format($q$delete from public.spreadsheet where id = '%s'$q$, rh.id('S'))) = '0', 'edit: B cannot delete the spreadsheet');
select rh.ok(rh.try(format($q$update public.canvas_item set data = '{"x":2}' where canvas_id = '%s'$q$, rh.id('C'))) = '1', 'edit: B edits items');
select rh.ok(rh.try(format($q$insert into public.canvas_item (canvas_id, workspace_id, id, sort_key, kind, data) values ('%s','%s','b1','b0','text','{}')$q$, rh.id('C'), rh.id('W'))) = '1', 'edit: B adds an item');
select rh.ok(rh.try(format($q$update public.canvas set title = 'Board, by B' where id = '%s'$q$, rh.id('C'))) = '1', 'edit: B renames the canvas');
select rh.ok(rh.try(format($q$insert into public.canvas_comment (canvas_id, workspace_id, body, author_id) values ('%s','%s','hi from B','%s')$q$, rh.id('C'), rh.id('W'), rh.m('B'))) = '1', 'edit: B comments on the canvas');
select rh.ok(rh.try(format($q$update public.canvas set visibility = 'workspace' where id = '%s'$q$, rh.id('C'))) like 'ERR%', 'edit: B cannot change who sees the canvas');
select rh.ok(rh.try(format($q$update public.canvas set owner_member_id = '%s' where id = '%s'$q$, rh.m('B'), rh.id('C'))) like 'ERR%', 'edit: B cannot take the canvas over');
select rh.ok(rh.try(format($q$update public.canvas set archived_at = now() where id = '%s'$q$, rh.id('C'))) like 'ERR%', 'edit: B cannot archive the canvas');
select rh.ok(rh.try(format($q$delete from public.canvas where id = '%s'$q$, rh.id('C'))) = '0', 'edit: B cannot delete the canvas');
select rh.ok(rh.try(format($q$insert into public.entity_access (workspace_id, entity_type, entity_id, grantee_kind, grantee_member_id, level, granted_by) values ('%s','spreadsheet','%s','member','%s','edit', (select public.current_member_id(rh.id('W'))))$q$, rh.id('W'), rh.id('S'), rh.m('C'))) like 'ERR%', 'edit: B cannot share it on');
select rh.ok(rh.try(format($q$update public.entity_access set level = 'edit' where entity_id = '%s'$q$, rh.id('S'))) in ('0') or rh.try(format($q$update public.entity_access set level = 'edit' where entity_id = '%s'$q$, rh.id('S'))) like 'ERR%', 'edit: B cannot change a grant''s level');
reset role;

-- ── 5. An admin with an edit grant: still no takeover, archive or delete ────
select rh.as_('A');
select rh.ok(rh.try(format($q$insert into public.entity_access (workspace_id, entity_type, entity_id, grantee_kind, grantee_member_id, level, granted_by) values ('%s','canvas','%s','member','%s','edit', (select public.current_member_id(rh.id('W'))))$q$, rh.id('W'), rh.id('C'), rh.m('X'))) = '1', 'A shares the canvas with admin X (edit)');
select rh.ok(rh.try(format($q$insert into public.entity_access (workspace_id, entity_type, entity_id, grantee_kind, grantee_member_id, level, granted_by) values ('%s','spreadsheet','%s','member','%s','edit', (select public.current_member_id(rh.id('W'))))$q$, rh.id('W'), rh.id('S'), rh.m('X'))) = '1', 'A shares the spreadsheet with admin X (edit)');
reset role;
select rh.as_('X');
select rh.ok(rh.try(format($q$update public.canvas set title = 'Board, by X' where id = '%s'$q$, rh.id('C'))) = '1', 'admin+edit: X edits the canvas');
select rh.ok(rh.try(format($q$update public.canvas set owner_member_id = '%s' where id = '%s'$q$, rh.m('X'), rh.id('C'))) like 'ERR%', 'admin+edit: X cannot reassign the canvas');
select rh.ok(rh.try(format($q$update public.canvas set archived_at = now() where id = '%s'$q$, rh.id('C'))) like 'ERR%', 'admin+edit: X cannot archive the canvas');
select rh.ok(rh.try(format($q$delete from public.canvas where id = '%s'$q$, rh.id('C'))) = '0', 'admin+edit: X cannot delete the canvas');
select rh.ok(rh.try(format($q$delete from public.spreadsheet where id = '%s'$q$, rh.id('S'))) = '0', 'admin+edit: X cannot delete the spreadsheet');
select rh.ok(rh.try(format($q$update public.spreadsheet set status = 'archived' where id = '%s'$q$, rh.id('S'))) like 'ERR%', 'admin+edit: X cannot archive the spreadsheet');
select rh.ok(rh.try(format($q$delete from public.entity_access where entity_id = '%s' and grantee_member_id = '%s'$q$, rh.id('C'), rh.m('B'))) = '0', 'admin+edit: X cannot remove B''s grant');
reset role;

-- ── 6. A guest: an edit grant is never an editor ────────────────────────────
select rh.as_('A');
select rh.ok(rh.try(format($q$insert into public.entity_access (workspace_id, entity_type, entity_id, grantee_kind, grantee_member_id, level, granted_by) values ('%s','canvas','%s','member','%s','edit', (select public.current_member_id(rh.id('W'))))$q$, rh.id('W'), rh.id('C'), rh.m('G'))) = '1', 'A grants guest G edit on the canvas');
select rh.ok(rh.try(format($q$insert into public.entity_access (workspace_id, entity_type, entity_id, grantee_kind, grantee_member_id, level, granted_by) values ('%s','spreadsheet','%s','member','%s','edit', (select public.current_member_id(rh.id('W'))))$q$, rh.id('W'), rh.id('S'), rh.m('G'))) = '1', 'A grants guest G edit on the spreadsheet');
reset role;
select rh.as_('G');
select rh.ok((select count(*) from public.canvas where id = rh.id('C')) = 1, 'guest: G reads the canvas (a grant reads, as for documents)');
select rh.ok(rh.try(format($q$update public.canvas_item set data = '{"x":3}' where canvas_id = '%s'$q$, rh.id('C'))) = '0', 'guest: G cannot edit items with an edit grant');
select rh.ok(rh.try(format($q$update public.spreadsheet set title = 'by G' where id = '%s'$q$, rh.id('S'))) = '0', 'guest: G cannot edit the spreadsheet with an edit grant');
select rh.ok(rh.try(format($q$insert into public.canvas_comment (canvas_id, workspace_id, body, author_id) values ('%s','%s','hi','%s')$q$, rh.id('C'), rh.id('W'), rh.m('G'))) like 'ERR%', 'guest: G cannot comment (a guest''s edit grant is view only)');
reset role;

-- ── 7. A team grant: its members, while they are members ────────────────────
select rh.as_('A');
select rh.ok(rh.try(format($q$insert into public.entity_access (workspace_id, entity_type, entity_id, grantee_kind, grantee_team_id, level, granted_by) values ('%s','canvas','%s','team','%s','view', (select public.current_member_id(rh.id('W'))))$q$, rh.id('W'), rh.id('C'), rh.id('T'))) = '1', 'A shares the canvas with team Design');
reset role;
select rh.as_('D');
select rh.ok((select count(*) from public.canvas where id = rh.id('C')) = 1, 'team: D (in Design) reads the canvas');
select rh.ok((select count(*) from public.canvas where id = any (public.my_canvas_ids())) = 1, 'team: my_canvas_ids lists it for D');
reset role;
delete from public.team_member where team_id = rh.id('T') and member_id = rh.m('D');
select rh.as_('D');
select rh.ok((select count(*) from public.canvas where id = rh.id('C')) = 0, 'team: D, out of the team, reads it no more');
reset role;

-- ── 8. The agent's reads (service role: auth.uid() null) ────────────────────
select rh.as_service();
grant usage on schema rh to service_role;
select rh.ok(public.visible_canvas_ids(array[rh.id('C')], rh.u('B'), true) = array[rh.id('C')], 'agent: visible_canvas_ids with grants has it for B');
select rh.ok(public.visible_canvas_ids(array[rh.id('C')], rh.u('B'), false) = '{}'::uuid[], 'agent: without grants (guest or linked turn) it does not');
select rh.ok(public.visible_spreadsheet_ids(array[rh.id('S')], rh.u('B'), true) = array[rh.id('S')], 'agent: visible_spreadsheet_ids with grants has it for B');
select rh.ok(public.visible_spreadsheet_ids(array[rh.id('S')], rh.u('B'), false) = '{}'::uuid[], 'agent: visible_spreadsheet_ids without grants does not');
select rh.ok(public.visible_spreadsheet_ids(array[rh.id('S')], rh.u('C'), true) = '{}'::uuid[], 'agent: C, no grant, gets nothing');
select rh.ok(rh.id('S') = any (public.entity_grant_ids_for('spreadsheet', rh.id('W'), rh.u('B'))), 'agent: entity_grant_ids_for lists the spreadsheet for B');
select rh.ok(rh.id('C') = any (public.entity_grant_ids_for('canvas', rh.id('W'), rh.u('B'))), 'agent: entity_grant_ids_for lists the canvas for B');
select rh.ok(not (rh.id('C') = any (public.entity_grant_ids_for('canvas', rh.id('W'), rh.u('A')))), 'agent: not for its owner');
reset role;
-- A signed-in caller asking about someone else gets no.
select rh.as_('C');
select rh.ok(not public.canvas_visible_to(rh.id('C'), rh.u('B')), 'a signed-in caller asks only about themself');
reset role;

-- ── 9. Revoke: B is out everywhere at once ──────────────────────────────────
select rh.as_('A');
select rh.ok(rh.try(format($q$delete from public.entity_access where entity_id in ('%s','%s') and grantee_member_id = '%s'$q$, rh.id('S'), rh.id('C'), rh.m('B'))) = '2', 'A stops sharing with B');
reset role;
select rh.as_('B');
select rh.ok((select count(*) from public.spreadsheet where id = rh.id('S')) + (select count(*) from public.canvas where id = rh.id('C'))
  + (select count(*) from public.canvas_item where canvas_id = rh.id('C')) + (select count(*) from public.canvas_comment where canvas_id = rh.id('C'))
  + (select count(*) from public.spreadsheet_comment where spreadsheet_id = rh.id('S')) = 0, 'revoked: B reads nothing');
select rh.ok(rh.try(format($q$update public.canvas_item set data = '{"x":4}' where canvas_id = '%s'$q$, rh.id('C'))) = '0', 'revoked: B writes nothing');
select rh.ok(set_config('realtime.topic', 'canvas-presence:' || rh.id('C'), false) is not null
  and (select count(*) from realtime.messages where topic = 'canvas-presence:' || rh.id('C')) = 0, 'revoked: B cannot join presence again');
select rh.ok(not public.spreadsheet_entity_visible_to(rh.id('S'), null, rh.u('B')), 'revoked: spreadsheet_entity_visible_to says no');
select case when rh.has_689() then rh.ok(set_config('realtime.topic', 'spreadsheet-presence:' || rh.id('S'), false) is not null
  and (select count(*) from realtime.messages where topic = 'spreadsheet-presence:' || rh.id('S')) = 0, 'revoked: B cannot hear spreadsheet presence (689)')::text else 'skipped (no 689): spreadsheet presence' end as presence_check;
reset role;

-- ── 10. A workspace record: nothing changes for anyone ──────────────────────
select rh.as_('C');
select rh.ok(rh.try(format($q$update public.spreadsheet set title = 'C edits an open one' where id = '%s'$q$, rh.id('S_open'))) = '1', 'workspace spreadsheet: any member still edits it (675)');
reset role;
select rh.as_('A');
select rh.ok(rh.try(format($q$update public.canvas set visibility = 'workspace' where id = '%s'$q$, rh.id('C'))) = '1', 'the owner still changes who sees the canvas');
select rh.ok(rh.try(format($q$update public.canvas set visibility = 'private' where id = '%s'$q$, rh.id('C'))) = '1', 'and back');
reset role;

-- ── 11. Notifications take the new type and targets ─────────────────────────
select rh.ok(rh.try(format($q$insert into public.notification (recipient_id, workspace_id, type, target_type, target_id, title) values ('%s','%s','record_shared','canvas','%s','A shared a canvas')$q$, rh.m('B'), rh.id('W'), rh.id('C'))) = '1', 'a record_shared notification on a canvas is accepted');
select rh.ok(rh.try(format($q$insert into public.notification (recipient_id, workspace_id, type, target_type, target_id, title) values ('%s','%s','record_shared','spreadsheet','%s','A shared a spreadsheet')$q$, rh.m('B'), rh.id('W'), rh.id('S'))) = '1', 'and on a spreadsheet');

-- ── Summary ─────────────────────────────────────────────────────────────────
reset role;
do $$
declare
  v_failed text;
  v_passed int;
begin
  select string_agg(label, '; ' order by n) into v_failed from rh.results where not ok;
  select count(*) into v_passed from rh.results where ok;
  if v_failed is not null then
    raise exception '688 record_sharing: failed: %', v_failed;
  end if;
  raise notice '688 record_sharing: all checks passed (%)', v_passed;
end $$;

rollback;
