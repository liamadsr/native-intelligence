-- DB-level test for migration 693 (drive_folder_grant_fence): a person who
-- sees someone else's private record ONLY through a grant (entity_access,
-- view or edit) cannot file it in a folder, move it between folders or take
-- it out of one. The record's own rule still files it: its owner, and any
-- member for a workspace record. Reading filings is unchanged.
--
-- Run against a database with the migrations applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/693_drive_folder_grant_fence.sql
-- Prints "693 drive_folder_grant_fence: all checks passed". Everything runs in
-- one transaction that is rolled back, and every attempt below runs in its
-- own subtransaction that is rolled back too. Made-up people only
-- (example.test). A failed check raises and aborts. The spreadsheet and
-- canvas checks run only when 688 (record sharing) is applied: before it,
-- neither kind can be shared at all.
--
-- People: Alice owns the private records; Bob is a member they are shared
-- with; Carol is a member with no grant.

begin;

-- Runs p_sql as p_user ('authenticated'), or as the service role when p_user
-- is null, inside a subtransaction that is always rolled back. Returns
-- 'rows=<n>' or 'refused:<sqlstate>'.
create or replace function pg_temp.attempt(p_user uuid, p_sql text) returns text language plpgsql as $f$
declare
  n int;
begin
  begin
    if p_user is null then
      perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
      execute 'set local role service_role';
    else
      perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
    end if;
    execute p_sql;
    get diagnostics n = row_count;
    raise exception using errcode = 'P0693', message = 'rows=' || n;
  exception when others then
    if sqlstate = 'P0693' then
      return sqlerrm;
    end if;
    return 'refused:' || sqlstate;
  end;
end $f$;

create or replace function pg_temp.expect(p_label text, p_got text, p_want text) returns void language plpgsql as $f$
begin
  if p_got is distinct from p_want then
    raise exception 'FAIL: % (got %, want %)', p_label, p_got, p_want;
  end if;
end $f$;

create or replace function pg_temp.file_sql(p_type text, p_id uuid, p_folder uuid, p_ws uuid) returns text language sql as $f$
  select format('insert into public.drive_folder_item (item_type, item_id, folder_id, workspace_id) values (%L, %L, %L, %L)', p_type, p_id, p_folder, p_ws)
$f$;
create or replace function pg_temp.move_sql(p_type text, p_id uuid, p_folder uuid) returns text language sql as $f$
  select format('update public.drive_folder_item set folder_id = %L where item_type = %L and item_id = %L', p_folder, p_type, p_id)
$f$;
create or replace function pg_temp.unfile_sql(p_type text, p_id uuid) returns text language sql as $f$
  select format('delete from public.drive_folder_item where item_type = %L and item_id = %L', p_type, p_id)
$f$;

do $probe$
declare
  u_alice constant uuid := '00000000-0000-4000-8000-000000693001';
  u_bob   constant uuid := '00000000-0000-4000-8000-000000693002';
  u_carol constant uuid := '00000000-0000-4000-8000-000000693003';
  ws uuid;
  m_alice uuid; m_bob uuid; m_carol uuid;
  f_alice uuid; f_bob uuid;
  d_private uuid; d_open uuid; t_private uuid; s_private uuid; c_private uuid;
  g_doc uuid;
  has_688 boolean;
begin
  insert into auth.users (id, email) values
    (u_alice, 'alice@t693.example.test'), (u_bob, 'bob@t693.example.test'), (u_carol, 'carol@t693.example.test');
  insert into public.workspace (name, slug) values ('t693 team', 't693-team-693') returning id into ws;
  insert into public.member (user_id, workspace_id, role, display_name) values (u_alice, ws, 'member', 'Alice T693') returning id into m_alice;
  insert into public.member (user_id, workspace_id, role, display_name) values (u_bob, ws, 'member', 'Bob T693') returning id into m_bob;
  insert into public.member (user_id, workspace_id, role, display_name) values (u_carol, ws, 'member', 'Carol T693') returning id into m_carol;

  insert into public.document (workspace_id, title, visibility, created_by) values (ws, 't693 private doc', 'private', m_alice) returning id into d_private;
  insert into public.document (workspace_id, title, visibility, created_by) values (ws, 't693 open doc', 'workspace', m_alice) returning id into d_open;
  insert into public.data_table (workspace_id, name, visibility, owner_member_id) values (ws, 't693 private table', 'private', m_alice) returning id into t_private;

  insert into public.drive_folder (workspace_id, name, created_by) values (ws, 'Alice files', m_alice) returning id into f_alice;
  insert into public.drive_folder (workspace_id, name, created_by) values (ws, 'Bob files', m_bob) returning id into f_bob;

  -- Alice shares her private document and table with Bob, to view.
  insert into public.entity_access (workspace_id, entity_type, entity_id, grantee_kind, grantee_member_id, level, granted_by)
    values (ws, 'document', d_private, 'member', m_bob, 'view', m_alice) returning id into g_doc;
  insert into public.entity_access (workspace_id, entity_type, entity_id, grantee_kind, grantee_member_id, level, granted_by)
    values (ws, 'data_table', t_private, 'member', m_bob, 'view', m_alice);

  -- ── A grantee never files, moves or unfiles the owner's private record ──
  perform pg_temp.expect('Bob reads the private document through his grant',
    pg_temp.attempt(u_bob, format('select 1 from public.document where id = %L', d_private)), 'rows=1');
  perform pg_temp.expect('Bob cannot file the private document (view grant)',
    pg_temp.attempt(u_bob, pg_temp.file_sql('document', d_private, f_bob, ws)), 'refused:42501');
  perform pg_temp.expect('Bob cannot file the private table (view grant)',
    pg_temp.attempt(u_bob, pg_temp.file_sql('data_table', t_private, f_bob, ws)), 'refused:42501');

  -- Alice files it herself.
  perform pg_temp.expect('Alice files her private document',
    pg_temp.attempt(u_alice, pg_temp.file_sql('document', d_private, f_alice, ws)), 'rows=1');
  insert into public.drive_folder_item (item_type, item_id, folder_id, workspace_id, added_by) values ('document', d_private, f_alice, ws, m_alice);

  perform pg_temp.expect('Bob still sees where Alice filed it',
    pg_temp.attempt(u_bob, format('select 1 from public.drive_folder_item where item_id = %L', d_private)), 'rows=1');
  perform pg_temp.expect('Bob cannot move it into his folder',
    pg_temp.attempt(u_bob, pg_temp.move_sql('document', d_private, f_bob)), 'rows=0');
  perform pg_temp.expect('Bob cannot take it out of her folder',
    pg_temp.attempt(u_bob, pg_temp.unfile_sql('document', d_private)), 'rows=0');

  -- An edit grant changes what it says, never where it lives.
  update public.entity_access set level = 'edit' where id = g_doc;
  perform pg_temp.expect('Bob, with an edit grant, still cannot move it',
    pg_temp.attempt(u_bob, pg_temp.move_sql('document', d_private, f_bob)), 'rows=0');
  perform pg_temp.expect('nor unfile it',
    pg_temp.attempt(u_bob, pg_temp.unfile_sql('document', d_private)), 'rows=0');
  delete from public.drive_folder_item where item_id = d_private;
  perform pg_temp.expect('nor file it',
    pg_temp.attempt(u_bob, pg_temp.file_sql('document', d_private, f_bob, ws)), 'refused:42501');

  -- ── Its own rule still files it: the owner, and anyone for a workspace record ──
  insert into public.drive_folder_item (item_type, item_id, folder_id, workspace_id, added_by) values ('document', d_private, f_alice, ws, m_alice);
  perform pg_temp.expect('Alice moves her private document',
    pg_temp.attempt(u_alice, pg_temp.move_sql('document', d_private, f_bob)), 'rows=1');
  perform pg_temp.expect('Alice unfiles her private document',
    pg_temp.attempt(u_alice, pg_temp.unfile_sql('document', d_private)), 'rows=1');

  perform pg_temp.expect('Carol files a workspace document',
    pg_temp.attempt(u_carol, pg_temp.file_sql('document', d_open, f_bob, ws)), 'rows=1');
  perform pg_temp.expect('Bob files a workspace document',
    pg_temp.attempt(u_bob, pg_temp.file_sql('document', d_open, f_bob, ws)), 'rows=1');
  insert into public.drive_folder_item (item_type, item_id, folder_id, workspace_id, added_by) values ('document', d_open, f_bob, ws, m_bob);
  perform pg_temp.expect('Carol moves a workspace document',
    pg_temp.attempt(u_carol, pg_temp.move_sql('document', d_open, f_alice)), 'rows=1');
  perform pg_temp.expect('Carol unfiles a workspace document',
    pg_temp.attempt(u_carol, pg_temp.unfile_sql('document', d_open)), 'rows=1');
  perform pg_temp.expect('Alice files her private table',
    pg_temp.attempt(u_alice, pg_temp.file_sql('data_table', t_private, f_alice, ws)), 'rows=1');

  -- Carol, with no grant, never saw the private document: 690's own rule.
  perform pg_temp.expect('Carol cannot file a private document she cannot open',
    pg_temp.attempt(u_carol, pg_temp.file_sql('document', d_private, f_bob, ws)), 'refused:42501');

  -- The service role is not held to it (the agents' tools check first).
  perform pg_temp.expect('the service role files any record',
    pg_temp.attempt(null, pg_temp.file_sql('data_table', t_private, f_bob, ws)), 'rows=1');

  -- ── A spreadsheet and a canvas, once 688 lets them be shared ──
  select pg_get_constraintdef(oid) like '%spreadsheet%' into has_688
    from pg_constraint where conname = 'entity_access_entity_type' and conrelid = 'public.entity_access'::regclass;
  if coalesce(has_688, false) then
    insert into public.spreadsheet (workspace_id, title, created_by, visibility) values (ws, 't693 private sheet', m_alice, 'private') returning id into s_private;
    insert into public.canvas (workspace_id, title, owner_member_id, created_by_user_id, visibility) values (ws, 't693 private board', m_alice, u_alice, 'private') returning id into c_private;
    insert into public.entity_access (workspace_id, entity_type, entity_id, grantee_kind, grantee_member_id, level, granted_by) values
      (ws, 'spreadsheet', s_private, 'member', m_bob, 'edit', m_alice),
      (ws, 'canvas', c_private, 'member', m_bob, 'view', m_alice);
    perform pg_temp.expect('Bob cannot file the private spreadsheet (edit grant)',
      pg_temp.attempt(u_bob, pg_temp.file_sql('spreadsheet', s_private, f_bob, ws)), 'refused:42501');
    perform pg_temp.expect('Bob cannot file the private canvas (view grant)',
      pg_temp.attempt(u_bob, pg_temp.file_sql('canvas', c_private, f_bob, ws)), 'refused:42501');
    perform pg_temp.expect('Alice files her private spreadsheet',
      pg_temp.attempt(u_alice, pg_temp.file_sql('spreadsheet', s_private, f_alice, ws)), 'rows=1');
    perform pg_temp.expect('Alice files her private canvas',
      pg_temp.attempt(u_alice, pg_temp.file_sql('canvas', c_private, f_alice, ws)), 'rows=1');
  else
    raise notice '693: no 688 here, so the spreadsheet and canvas checks are skipped (neither can be shared yet)';
  end if;
end
$probe$;

select '693 drive_folder_grant_fence: all checks passed' as result;

rollback;
