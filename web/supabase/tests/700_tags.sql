-- DB-level test for migration 700 (tags): who sees, creates, changes and sets
-- tags, personal tags never shown to anyone else (nor written into the
-- free-text tags columns), the mirror both ways, records_with_tags, a move and
-- a merge.
--
-- Run against a database with the migrations applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/700_tags.sql
-- Prints "700 tags: all checks passed". Everything runs in one transaction that
-- is rolled back; each attempt runs in its own subtransaction. Made-up people
-- only (example.com). A failed check raises at the end, naming every failure.
--
-- People: O owns the workspace; M is a member; G a guest; V a member who sees
-- O's private page only through a view grant; S a stranger in another workspace.
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
set client_min_messages = warning;
begin;
-- Rehearsal of 700 on a local copy of main's schema. Made-up people and ids.

create schema t;
create table t.results (n serial, ok boolean, what text);
create or replace function t.check(ok boolean, what text) returns void language sql as
$$ insert into t.results (ok, what) values (coalesce(ok, false), what) $$;
-- run a statement as a person; returns the error code, or 'ok'
create or replace function t.try(uid uuid, stmt text) returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', uid::text, true);
  execute 'set local role authenticated';
  execute stmt;
  execute 'reset role';
  return 'ok';
exception when others then
  execute 'reset role';
  return sqlstate;
end $$;
-- count rows a query returns as a person
create or replace function t.cnt(uid uuid, stmt text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claim.sub', uid::text, true);
  execute 'set local role authenticated';
  execute 'select count(*) from (' || stmt || ') x' into n;
  execute 'reset role';
  return n;
end $$;
grant usage on schema t to authenticated;
grant all on all tables in schema t to authenticated;
grant all on all sequences in schema t to authenticated;

-- people: O owner, M member, G guest, V member who sees a private doc only by a view grant, S stranger
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner@example.com'),
  ('00000000-0000-4000-8000-0000000000a2', 'member@example.com'),
  ('00000000-0000-4000-8000-0000000000a3', 'guest@example.com'),
  ('00000000-0000-4000-8000-0000000000a4', 'viewer@example.com'),
  ('00000000-0000-4000-8000-0000000000a5', 'stranger@example.com')
on conflict do nothing;

create temp table ids as
select (select workspace_id from member where user_id = '00000000-0000-4000-8000-0000000000a1') as w,
       (select workspace_id from member where user_id = '00000000-0000-4000-8000-0000000000a5') as w2;

insert into member (user_id, workspace_id, role, display_name)
select u, (select w from ids), r, n from (values
  ('00000000-0000-4000-8000-0000000000a2'::uuid, 'member', 'Mia Member'),
  ('00000000-0000-4000-8000-0000000000a3'::uuid, 'guest', 'Gus Guest'),
  ('00000000-0000-4000-8000-0000000000a4'::uuid, 'member', 'Vic Viewer')) v(u, r, n)
on conflict do nothing;

-- records in W: a team and an action, a workspace doc, a private doc of O, a contact
insert into team (id, workspace_id, name, slug, issue_prefix)
select 'c0000000-0000-4000-8000-000000000001', w, 'Ops', 'ops', 'OPS' from ids on conflict do nothing;
insert into actions (id, title, user_id, workspace_id, team_id, status_id, identifier)
select 'ac000000-0000-4000-8000-000000000001', 'Renew the lease', '00000000-0000-4000-8000-0000000000a1', w,
       'c0000000-0000-4000-8000-000000000001',
       (select id from workflow_state where team_id = 'c0000000-0000-4000-8000-000000000001' order by sort_order limit 1), 'OPS-1'
from ids on conflict do nothing;
insert into document (id, workspace_id, title, created_by, visibility)
select 'd0000000-0000-4000-8000-000000000001', w, 'Shared page',
       (select id from member where user_id = '00000000-0000-4000-8000-0000000000a1' and workspace_id = ids.w), 'workspace' from ids
on conflict do nothing;
insert into document (id, workspace_id, title, created_by, visibility)
select 'd0000000-0000-4000-8000-000000000002', w, 'Private page',
       (select id from member where user_id = '00000000-0000-4000-8000-0000000000a1' and workspace_id = ids.w), 'private' from ids
on conflict do nothing;
insert into entity_access (workspace_id, entity_type, entity_id, grantee_kind, grantee_member_id, level, granted_by, source)
select w, 'document', 'd0000000-0000-4000-8000-000000000002', 'member',
       (select id from member where user_id = '00000000-0000-4000-8000-0000000000a4' and workspace_id = ids.w), 'view',
       (select id from member where user_id = '00000000-0000-4000-8000-0000000000a1' and workspace_id = ids.w), 'manual'
from ids;
insert into contact (id, workspace_id, full_name, visibility)
select 'cc000000-0000-4000-8000-000000000001', w, 'Pat Example', 'workspace' from ids on conflict do nothing;

-- tags: a workspace tag W1 made by O, a personal tag of M, one in the stranger's workspace
insert into label (id, workspace_id, name, color, created_by)
select 'b0000000-0000-4000-8000-000000000001', w, 'Renewal', '#22c55e', '00000000-0000-4000-8000-0000000000a1' from ids;
insert into label (id, workspace_id, name, color, owner_user_id, created_by)
select 'b0000000-0000-4000-8000-000000000002', w, 'MiaOnly', '#ef4444', '00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000a2' from ids;
insert into label (id, workspace_id, name, color, created_by)
select 'b0000000-0000-4000-8000-000000000003', w2, 'Elsewhere', '#000000', '00000000-0000-4000-8000-0000000000a5' from ids;

\set O '''00000000-0000-4000-8000-0000000000a1'''
\set M '''00000000-0000-4000-8000-0000000000a2'''
\set G '''00000000-0000-4000-8000-0000000000a3'''
\set V '''00000000-0000-4000-8000-0000000000a4'''
\set S '''00000000-0000-4000-8000-0000000000a5'''

create temp table ws as select (select workspace_id from member where user_id = :O limit 1) as w,
  (select workspace_id from member where user_id = :S limit 1) as w2;
grant select on ws to authenticated;

-- 1. who sees which tags
select t.check(t.cnt(:O, 'select 1 from label where id in (''b0000000-0000-4000-8000-000000000001'',''b0000000-0000-4000-8000-000000000002'')') = 1, '1a owner sees the workspace tag, not Mia''s personal one');
select t.check(t.cnt(:M, 'select 1 from label where id in (''b0000000-0000-4000-8000-000000000001'',''b0000000-0000-4000-8000-000000000002'')') = 2, '1b Mia sees both');
select t.check(t.cnt(:S, 'select 1 from label where id = ''b0000000-0000-4000-8000-000000000001''') = 0, '1c a stranger sees none');

-- 2. who may create
select t.check(t.try(:M, format('insert into label (id, workspace_id, name, color) values (''b0000000-0000-4000-8000-000000000011'', %L, ''Q4'', ''#3b82f6'')', (select w from ws))) = 'ok', '2a a member creates a workspace tag');
select t.check((select created_by from label where id = 'b0000000-0000-4000-8000-000000000011') = :M, '2b created_by is the member');
select t.check(t.try(:G, format('insert into label (workspace_id, name, color) values (%L, ''GuestShared'', ''#3b82f6'')', (select w from ws))) = '42501', '2c a guest cannot create a workspace tag');
select t.check(t.try(:G, format('insert into label (id, workspace_id, name, color, owner_user_id) values (''b0000000-0000-4000-8000-000000000012'', %L, ''GusOnly'', ''#3b82f6'', %L)', (select w from ws), :G)) = 'ok', '2d a guest creates a personal tag');
select t.check(t.try(:M, format('insert into label (workspace_id, name, color, owner_user_id) values (%L, ''ForOwner'', ''#3b82f6'', %L)', (select w from ws), :O)) = '42501', '2e nobody makes a personal tag for someone else');
select t.check(t.try(:M, format('insert into label (workspace_id, name, color) values (%L, ''#hash'', ''#3b82f6'')', (select w from ws))) = '22023', '2f a name may not start with #');
select t.check(t.try(:M, format('insert into label (workspace_id, name, color) values (%L, ''Bad'', ''red'')', (select w from ws))) = '22023', '2g a color is hex');
select t.check(t.try(:M, format('insert into label (workspace_id, name, color, scopes) values (%L, ''Bad2'', ''#3b82f6'', ''{team}'')', (select w from ws))) = '22023', '2h a scope is a taggable kind');
select t.check(t.try(:M, format('insert into label (workspace_id, name, color) values (%L, ''Q4'', ''#3b82f6'')', (select w from ws))) = '23505', '2i two workspace tags never share a name');
select t.check(t.try(:M, format('insert into label (id, workspace_id, name, color, owner_user_id) values (''b0000000-0000-4000-8000-000000000013'', %L, ''Q4'', ''#3b82f6'', %L)', (select w from ws), :M)) = 'ok', '2j a personal tag may share a workspace tag''s name');
select t.check(t.try(:S, format('insert into label (workspace_id, name, color) values (%L, ''Intruder'', ''#3b82f6'')', (select w from ws))) = '42501', '2k a stranger cannot create in the workspace');

-- 3. who may change
select t.try(:M, 'update label set name = ''Renamed'' where id = ''b0000000-0000-4000-8000-000000000001''');
select t.check((select name from label where id = 'b0000000-0000-4000-8000-000000000001') = 'Renewal', '3a a member cannot rename someone else''s workspace tag');
select t.try(:M, 'update label set color = ''#a855f7'' where id = ''b0000000-0000-4000-8000-000000000011''');
select t.check((select color from label where id = 'b0000000-0000-4000-8000-000000000011') = '#a855f7', '3b its creator recolors it');
select t.check(t.try(:O, 'update label set owner_user_id = ''00000000-0000-4000-8000-0000000000a1'' where id = ''b0000000-0000-4000-8000-000000000001''') <> 'ok', '3c a workspace tag never becomes personal');
select t.check(t.try(:O, 'update label set workspace_id = (select w2 from ws) where id = ''b0000000-0000-4000-8000-000000000001''') <> 'ok', '3d a tag keeps its workspace');
select t.try(:O, 'delete from label where id = ''b0000000-0000-4000-8000-000000000002''');
select t.check(exists (select 1 from label where id = 'b0000000-0000-4000-8000-000000000002'), '3e the owner cannot delete (or see) Mia''s personal tag');
select t.try(:M, 'delete from label where id = ''b0000000-0000-4000-8000-000000000001''');
select t.check(exists (select 1 from label where id = 'b0000000-0000-4000-8000-000000000001'), '3f a member cannot delete someone else''s workspace tag');

-- 4. old join tables
select t.check(t.try(:M, 'insert into action_label (action_id, label_id) values (''ac000000-0000-4000-8000-000000000001'', ''b0000000-0000-4000-8000-000000000001'')') = 'ok', '4a a member tags an action');
select t.check(t.try(:M, 'insert into action_label (action_id, label_id) values (''ac000000-0000-4000-8000-000000000001'', ''b0000000-0000-4000-8000-000000000002'')') = 'ok', '4b with her personal tag too');
select t.check(t.cnt(:O, 'select 1 from action_label where action_id = ''ac000000-0000-4000-8000-000000000001''') = 1, '4c the owner sees one tag on it, not Mia''s');
select t.check(t.cnt(:M, 'select 1 from action_label where action_id = ''ac000000-0000-4000-8000-000000000001''') = 2, '4d Mia sees both');
select t.check(t.try(:M, 'insert into action_label (action_id, label_id) values (''ac000000-0000-4000-8000-000000000001'', ''b0000000-0000-4000-8000-000000000003'')') = '42501', '4e no tag from another workspace');
select t.check(t.try(:O, 'insert into action_label (action_id, label_id) values (''ac000000-0000-4000-8000-000000000001'', ''b0000000-0000-4000-8000-000000000012'')') = '42501', '4f no one else''s personal tag');
select t.check(t.try(:G, 'insert into action_label (action_id, label_id) values (''ac000000-0000-4000-8000-000000000001'', ''b0000000-0000-4000-8000-000000000011'')') = '42501', '4g a guest cannot add a workspace tag');
select t.check(t.try(:G, 'insert into action_label (action_id, label_id) values (''ac000000-0000-4000-8000-000000000001'', ''b0000000-0000-4000-8000-000000000012'')') = 'ok', '4h a guest adds their own personal tag');
select t.try(:O, 'delete from action_label where label_id = ''b0000000-0000-4000-8000-000000000002''');
select t.check(exists (select 1 from action_label where label_id = 'b0000000-0000-4000-8000-000000000002'), '4i nobody removes Mia''s personal tag but Mia');
select t.check(t.try(:O, 'update action_label set label_id = ''b0000000-0000-4000-8000-000000000003'' where label_id = ''b0000000-0000-4000-8000-000000000001''') = '42501', '4j an update cannot point a row at another workspace''s tag');
select t.check(t.try(:S, 'insert into action_label (action_id, label_id) values (''ac000000-0000-4000-8000-000000000001'', ''b0000000-0000-4000-8000-000000000003'')') <> 'ok', '4k a stranger cannot tag the action');

-- 5. new join tables and record visibility
select t.check(t.try(:M, 'insert into document_label (document_id, label_id) values (''d0000000-0000-4000-8000-000000000001'', ''b0000000-0000-4000-8000-000000000001'')') = 'ok', '5a a member tags a shared doc');
select t.check(t.try(:O, 'insert into document_label (document_id, label_id) values (''d0000000-0000-4000-8000-000000000002'', ''b0000000-0000-4000-8000-000000000001'')') = 'ok', '5b the owner tags her private doc');
select t.check(t.try(:M, 'insert into document_label (document_id, label_id) values (''d0000000-0000-4000-8000-000000000002'', ''b0000000-0000-4000-8000-000000000011'')') <> 'ok', '5c a member who cannot read the private doc cannot tag it');
select t.check(t.cnt(:M, 'select 1 from document_label where document_id = ''d0000000-0000-4000-8000-000000000002''') = 0, '5d ... nor see its tags');
select t.check(t.cnt(:V, 'select 1 from document_label where document_id = ''d0000000-0000-4000-8000-000000000002''') = 1, '5e the view grantee sees its tag');
select t.check(t.try(:V, 'insert into document_label (document_id, label_id) values (''d0000000-0000-4000-8000-000000000002'', ''b0000000-0000-4000-8000-000000000011'')') = '42501', '5f a view grantee cannot add a workspace tag');
select t.try(:V, 'delete from document_label where document_id = ''d0000000-0000-4000-8000-000000000002''');
select t.check(t.cnt(:O, 'select 1 from document_label where document_id = ''d0000000-0000-4000-8000-000000000002''') = 1, '5g ... nor remove one');
select t.try(:V, format('insert into label (id, workspace_id, name, color, owner_user_id) values (''b0000000-0000-4000-8000-000000000014'', %L, ''VicOnly'', ''#3b82f6'', %L)', (select w from ws), :V));
select t.check(t.try(:V, 'insert into document_label (document_id, label_id) values (''d0000000-0000-4000-8000-000000000002'', ''b0000000-0000-4000-8000-000000000014'')') = 'ok', '5h a view grantee adds their own personal tag');
select t.check(t.cnt(:O, 'select 1 from document_label where document_id = ''d0000000-0000-4000-8000-000000000002''') = 1, '5i which the owner does not see');
select t.check(t.try(:S, 'insert into document_label (document_id, label_id) values (''d0000000-0000-4000-8000-000000000001'', ''b0000000-0000-4000-8000-000000000003'')') <> 'ok', '5j a stranger cannot tag a doc');
select t.check(t.try(:M, 'update document_label set label_id = ''b0000000-0000-4000-8000-000000000011'' where document_id = ''d0000000-0000-4000-8000-000000000001''') <> 'ok' or t.cnt(:M, 'select 1 from document_label where label_id = ''b0000000-0000-4000-8000-000000000011''') = 0, '5k no updates on the new tables');

-- 6. the mirror on contact.tags
select t.check(t.try(:M, 'insert into contact_label (contact_id, label_id) values (''cc000000-0000-4000-8000-000000000001'', ''b0000000-0000-4000-8000-000000000001'')') = 'ok', '6a a member tags a contact');
select t.check((select tags from contact where id = 'cc000000-0000-4000-8000-000000000001') = '{Renewal}', '6b its tags column follows');
select t.try(:M, 'insert into contact_label (contact_id, label_id) values (''cc000000-0000-4000-8000-000000000001'', ''b0000000-0000-4000-8000-000000000002'')');
select t.check((select tags from contact where id = 'cc000000-0000-4000-8000-000000000001') = '{Renewal}', '6c a personal tag never reaches the column');
update contact set tags = '{VIP, renewal, " vip "}' where id = 'cc000000-0000-4000-8000-000000000001';
select t.check((select tags from contact where id = 'cc000000-0000-4000-8000-000000000001') = '{Renewal,VIP}', '6d a service write becomes workspace tags (matched by name, no duplicates) and reads back canonical');
select t.check((select count(*) from label where workspace_id = (select w from ws) and lower(name) = 'vip') = 1, '6e VIP was created once');
select t.check(exists (select 1 from contact_label where contact_id = 'cc000000-0000-4000-8000-000000000001' and label_id = 'b0000000-0000-4000-8000-000000000002'), '6f Mia''s personal tag survived the rewrite');
select t.try(:M, 'delete from contact_label where contact_id = ''cc000000-0000-4000-8000-000000000001'' and label_id = ''b0000000-0000-4000-8000-000000000001''');
select t.check((select tags from contact where id = 'cc000000-0000-4000-8000-000000000001') = '{VIP}', '6g untagging updates the column');
select t.try(:O, 'update label set name = ''Key'' where workspace_id = (select w from ws) and name = ''VIP''');
select t.check((select tags from contact where id = 'cc000000-0000-4000-8000-000000000001') = '{Key}', '6h a rename reaches the column');
insert into contact (id, workspace_id, full_name, visibility, tags)
select 'cc000000-0000-4000-8000-000000000002', w, 'Sam Example', 'workspace', '{Alpha}' from ws;
select t.check(exists (select 1 from contact_label j join label l on l.id = j.label_id
                        where j.contact_id = 'cc000000-0000-4000-8000-000000000002' and l.name = 'Alpha' and l.owner_user_id is null), '6i an insert with tags (CRM import) tags the contact');
select t.try(:M, 'update label set owner_user_id = null where id = ''b0000000-0000-4000-8000-000000000002''');
select t.check((select tags from contact where id = 'cc000000-0000-4000-8000-000000000001') = '{Key,MiaOnly}', '6j a personal tag made shared joins the column');
select t.check(t.cnt(:O, 'select 1 from label where id = ''b0000000-0000-4000-8000-000000000002''') = 1, '6k ... and everyone sees it');

-- 7. records_with_tags
insert into action_label (action_id, label_id) values ('ac000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000011') on conflict do nothing;
select t.check(t.cnt(:O, format('select * from records_with_tags(%L, array[''b0000000-0000-4000-8000-000000000001''::uuid])', (select w from ws))) = 3, '7a any: the action and both docs');
select t.check(t.cnt(:M, format('select * from records_with_tags(%L, array[''b0000000-0000-4000-8000-000000000001''::uuid])', (select w from ws))) = 2, '7b Mia does not get the private doc');
select t.check(t.cnt(:O, format('select * from records_with_tags(%L, array[''b0000000-0000-4000-8000-000000000001''::uuid, ''b0000000-0000-4000-8000-000000000011''::uuid], ''all'')', (select w from ws))) = 1, '7c all: only the action has both');
select t.check(t.cnt(:S, format('select * from records_with_tags(%L, array[''b0000000-0000-4000-8000-000000000001''::uuid])', (select w from ws))) = 0, '7d a stranger gets nothing');
select t.check(t.cnt(:O, 'select * from tagged_records where label_id = ''b0000000-0000-4000-8000-000000000012''') = 0, '7e the view hides another''s personal tag');

-- 8. a doc moved to another workspace keeps its tags by name
update document set workspace_id = (select w2 from ws) where id = 'd0000000-0000-4000-8000-000000000001';
select t.check((select l.workspace_id = (select w2 from ws) and l.name = 'Renewal' from document_label j join label l on l.id = j.label_id
                 where j.document_id = 'd0000000-0000-4000-8000-000000000001'), '8a the moved doc carries a Renewal tag of its new workspace');
select t.check((select count(*) from document_label where document_id = 'd0000000-0000-4000-8000-000000000001') = 1, '8b and only that one');

-- 9. the old move helper matches owners
select t.check(public._wsmove_remap_labels('action_label', 'action_id', array['ac000000-0000-4000-8000-000000000001'::uuid], (select w from ws), (select w2 from ws)) is not null, '9a the remap helper runs');


-- 10. files follow main's attachments rules: a private capture's file
insert into captures (id, title, user_id, workspace_id, visibility)
select 'ca000000-0000-4000-8000-000000000001', 'Private call', :O, w, 'private' from ws;
insert into attachments (id, user_id, note_id, workspace_id, file_name, file_size_bytes, mime_type, file_extension, file_category, storage_path)
select 'af000000-0000-4000-8000-000000000001', :O, 'ca000000-0000-4000-8000-000000000001', w, 'notes.pdf', 10, 'application/pdf', 'pdf', 'document', 'x/notes.pdf' from ws;
select t.check(t.try(:O, 'insert into attachment_label (attachment_id, label_id) values (''af000000-0000-4000-8000-000000000001'', ''b0000000-0000-4000-8000-000000000001'')') = 'ok', '10a the owner tags her private call''s file');
select t.check(t.try(:M, 'insert into attachment_label (attachment_id, label_id) values (''af000000-0000-4000-8000-000000000001'', ''b0000000-0000-4000-8000-000000000011'')') <> 'ok', '10b a member who cannot see the file cannot tag it');
select t.check(t.cnt(:M, 'select 1 from attachment_label where attachment_id = ''af000000-0000-4000-8000-000000000001''') = 0, '10c ... nor see its tags');
select t.check(t.try(:M, 'insert into capture_label (capture_id, label_id) values (''ca000000-0000-4000-8000-000000000001'', ''b0000000-0000-4000-8000-000000000011'')') <> 'ok', '10d nor tag the private capture (open to her under 108 before)');
select t.check(t.cnt(:M, 'select 1 from capture_label where capture_id = ''ca000000-0000-4000-8000-000000000001''') = 0, '10e nor read its labels');


-- 11. a workspace merge folds tags by kind and owner. merge_workspace on main at
-- 693 fails before it reaches tags (_wsmerge_members writes
-- slack_user_link.member_id, which no migration creates), so this part runs
-- only where that column exists.
set client_min_messages = notice;
do $m$ begin
  if not exists (select 1 from information_schema.columns where table_name = 'slack_user_link' and column_name = 'member_id') then
    raise notice '700: merge checks skipped: merge_workspace cannot run on this database (slack_user_link.member_id is missing)';
  end if;
end $m$;
set client_min_messages = warning;
\if :{?skip_merge}
\else
select exists (select 1 from information_schema.columns where table_name = 'slack_user_link' and column_name = 'member_id') as can_merge \gset
\if :can_merge
-- O owns both workspaces S and D; one company (same domain) folds; tags of every kind.
insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000b1', 'mo@example.com') on conflict do nothing;
create temp table m as select (select workspace_id from member where user_id = '00000000-0000-4000-8000-0000000000b1') as s;
insert into workspace (id, name, slug) values ('e0000000-0000-4000-8000-0000000000d1', 'Dest', 'dest-merge');
insert into member (user_id, workspace_id, role, display_name) values ('00000000-0000-4000-8000-0000000000b1', 'e0000000-0000-4000-8000-0000000000d1', 'owner', 'Mo');
alter table m add column d uuid default 'e0000000-0000-4000-8000-0000000000d1';

-- source tags
insert into label (id, workspace_id, name) select 'f0000000-0000-4000-8000-000000000001', s, 'Renewal' from m;                 -- workspace
insert into label (id, workspace_id, name, owner_user_id) select 'f0000000-0000-4000-8000-000000000002', s, 'Mine', '00000000-0000-4000-8000-0000000000b1' from m; -- personal
insert into label (id, workspace_id, name) select 'f0000000-0000-4000-8000-000000000003', s, 'OnlyHere' from m;
-- destination tags: a personal 'Renewal' made BEFORE the workspace 'renewal' (the trap), and a personal 'mine'
insert into label (id, workspace_id, name, owner_user_id, created_at) select 'f0000000-0000-4000-8000-000000000011', d, 'Renewal', '00000000-0000-4000-8000-0000000000b1', now() - interval '2 days' from m;
insert into label (id, workspace_id, name, created_at) select 'f0000000-0000-4000-8000-000000000012', d, 'renewal', now() - interval '1 day' from m;
insert into label (id, workspace_id, name, owner_user_id) select 'f0000000-0000-4000-8000-000000000013', d, 'mine', '00000000-0000-4000-8000-0000000000b1' from m;

-- a company in each with the same domain (folds), the source one tagged; a source doc tagged
insert into company (id, workspace_id, name, domain) select 'e1000000-0000-4000-8000-000000000001', s, 'Acme', 'acme.example' from m;
insert into company (id, workspace_id, name, domain) select 'e1000000-0000-4000-8000-000000000002', d, 'Acme', 'acme.example' from m;
insert into company_label (company_id, label_id) values
  ('e1000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001'),
  ('e1000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000002'),
  ('e1000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000003');
insert into document (id, workspace_id, title, created_by, visibility)
select 'e2000000-0000-4000-8000-000000000001', s, 'Doc', (select id from member where user_id = '00000000-0000-4000-8000-0000000000b1' and workspace_id = m.s), 'workspace' from m;
insert into document_label (document_id, label_id) values ('e2000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001');

update company set stage_id = null where workspace_id = (select d from m); delete from company_stage where workspace_id = (select d from m);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000b1', false);
select null from public.merge_workspace((select s from m), (select d from m), '00000000-0000-4000-8000-0000000000b1', '{}'::jsonb) as result;

select t.check((select string_agg(l.name || case when l.owner_user_id is null then '(ws)' else '(personal)' end, ', ' order by l.name)
  from company_label j join label l on l.id = j.label_id where j.company_id = 'e1000000-0000-4000-8000-000000000002')
  = 'OnlyHere(ws), mine(personal), renewal(ws)', '11a the folded company keeps every tag, each folded into its own kind');
select t.check((select l.id from document_label j join label l on l.id = j.label_id where j.document_id = 'e2000000-0000-4000-8000-000000000001')
  = 'f0000000-0000-4000-8000-000000000012', '11b a workspace tag folds into the workspace twin, not an older personal one of the same name');
select t.check((select count(*) from label, m where workspace_id = m.d) = 4, '11c the destination keeps four tags: both kinds of Renewal, mine, OnlyHere');

\endif
\endif

set client_min_messages = notice;
do $r$
declare v_fail text;
begin
  select string_agg(what, '; ' order by n) into v_fail from t.results where not ok;
  if v_fail is not null then
    raise exception '700 tags: FAILED: %', v_fail;
  end if;
  raise notice '700 tags: all checks passed (% checks)', (select count(*) from t.results);
end $r$;
rollback;
