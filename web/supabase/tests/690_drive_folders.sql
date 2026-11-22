-- DB-level test for migration 690 (drive_folders): folders are the
-- workspace's members' (never a guest's); a folder keeps its workspace and
-- its maker, sits only in a folder of its own workspace and never inside
-- itself; a record is filed only by someone who can open it, in its own
-- workspace, as themself; a private record filed by its maker stays out of
-- everyone else's reach.
--
-- Run against a database with the migrations applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/690_drive_folders.sql
-- Prints "690 drive_folders: all checks passed". Everything runs in one
-- transaction that is rolled back, and every attempt below runs in its own
-- subtransaction that is rolled back too, so each starts from the same rows.
-- Made-up people only (example.test). A failed check raises and aborts.
--
-- People: Alice and Bob are members of the team's workspace, Dana an admin,
-- Gwen a guest; Eve owns another workspace.

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
    raise exception using errcode = 'P0690', message = 'rows=' || n;
  exception when others then
    if sqlstate = 'P0690' then
      return sqlerrm;
    end if;
    return 'refused:' || sqlstate;
  end;
end $f$;

-- The first column of p_sql's first row, read as p_user (null when none).
create or replace function pg_temp.read_as(p_user uuid, p_sql text) returns text language plpgsql as $f$
declare
  v text;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    execute p_sql into v;
    raise exception using errcode = 'P0691', message = coalesce(v, '<none>');
  exception when others then
    if sqlstate = 'P0691' then
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

do $probe$
declare
  u_alice constant uuid := '00000000-0000-4000-8000-000000690001';
  u_bob   constant uuid := '00000000-0000-4000-8000-000000690002';
  u_dana  constant uuid := '00000000-0000-4000-8000-000000690004';
  u_gwen  constant uuid := '00000000-0000-4000-8000-000000690005';
  u_eve   constant uuid := '00000000-0000-4000-8000-000000690006';
  ws uuid; ws2 uuid;
  m_alice uuid; m_bob uuid; m_dana uuid; m_eve uuid;
  f_top uuid; f_sub uuid; f_bob uuid; f_other uuid;
  d_shared uuid; d_private uuid; d_other uuid; s_shared uuid;
begin
  insert into auth.users (id, email) values
    (u_alice, 'alice@team.example.test'), (u_bob, 'bob@team.example.test'),
    (u_dana, 'dana@team.example.test'), (u_gwen, 'gwen@guest.example.test'),
    (u_eve, 'eve@elsewhere.example.test');

  insert into public.workspace (name, slug) values ('t690 team', 't690-team-690') returning id into ws;
  insert into public.workspace (name, slug) values ('t690 elsewhere', 't690-elsewhere-690') returning id into ws2;
  insert into public.member (user_id, workspace_id, role, display_name) values (u_alice, ws, 'member', 'Alice T690') returning id into m_alice;
  insert into public.member (user_id, workspace_id, role, display_name) values (u_bob, ws, 'member', 'Bob T690') returning id into m_bob;
  insert into public.member (user_id, workspace_id, role, display_name) values (u_dana, ws, 'admin', 'Dana T690') returning id into m_dana;
  insert into public.member (user_id, workspace_id, role, display_name) values (u_gwen, ws, 'guest', 'Gwen T690');
  insert into public.member (user_id, workspace_id, role, display_name) values (u_eve, ws2, 'owner', 'Eve T690') returning id into m_eve;

  insert into public.document (workspace_id, title, visibility, created_by) values (ws, 't690 shared doc', 'workspace', m_alice) returning id into d_shared;
  insert into public.document (workspace_id, title, visibility, created_by) values (ws, 't690 private doc', 'private', m_alice) returning id into d_private;
  insert into public.document (workspace_id, title, visibility, created_by) values (ws2, 't690 elsewhere doc', 'workspace', m_eve) returning id into d_other;
  insert into public.spreadsheet (workspace_id, title, created_by) values (ws, 't690 sheet', m_alice) returning id into s_shared;

  insert into public.drive_folder (workspace_id, name, created_by) values (ws, 'Clients', m_alice) returning id into f_top;
  insert into public.drive_folder (workspace_id, name, parent_id, created_by) values (ws, 'Acme', f_top, m_alice) returning id into f_sub;
  insert into public.drive_folder (workspace_id, name, created_by) values (ws, 'Bob''s', m_bob) returning id into f_bob;
  insert into public.drive_folder (workspace_id, name, created_by) values (ws2, 'Elsewhere', m_eve) returning id into f_other;

  -- ── Folders: who sees and makes them ──
  perform pg_temp.expect('a member sees the workspace''s folders',
    pg_temp.read_as(u_bob, format('select count(*)::text from public.drive_folder where workspace_id = %L', ws)), '3');
  perform pg_temp.expect('a guest sees none',
    pg_temp.read_as(u_gwen, format('select count(*)::text from public.drive_folder where workspace_id = %L', ws)), '0');
  perform pg_temp.expect('another workspace''s owner sees none',
    pg_temp.read_as(u_eve, format('select count(*)::text from public.drive_folder where workspace_id = %L', ws)), '0');
  perform pg_temp.expect('a member makes a folder as themself',
    pg_temp.attempt(u_bob, format('insert into public.drive_folder (workspace_id, name, created_by) values (%L, %L, %L)', ws, 'Notes', m_bob)), 'rows=1');
  perform pg_temp.expect('a member makes one inside a folder',
    pg_temp.attempt(u_bob, format('insert into public.drive_folder (workspace_id, name, parent_id, created_by) values (%L, %L, %L, %L)', ws, 'Notes', f_top, m_bob)), 'rows=1');
  perform pg_temp.expect('nobody makes one as someone else',
    pg_temp.attempt(u_bob, format('insert into public.drive_folder (workspace_id, name, created_by) values (%L, %L, %L)', ws, 'Notes', m_alice)), 'refused:42501');
  perform pg_temp.expect('a guest makes none',
    pg_temp.attempt(u_gwen, format('insert into public.drive_folder (workspace_id, name, created_by) values (%L, %L, (select id from public.member where user_id = auth.uid() and workspace_id = %L))', ws, 'Notes', ws)), 'refused:42501');
  perform pg_temp.expect('nobody makes one in another workspace',
    pg_temp.attempt(u_bob, format('insert into public.drive_folder (workspace_id, name, created_by) values (%L, %L, %L)', ws2, 'Notes', m_bob)), 'refused:42501');
  perform pg_temp.expect('nobody puts one inside another workspace''s folder',
    pg_temp.attempt(u_eve, format('insert into public.drive_folder (workspace_id, name, parent_id, created_by) values (%L, %L, %L, %L)', ws2, 'Sneaky', f_top, m_eve)), 'refused:42501');
  perform pg_temp.expect('an empty name is refused',
    pg_temp.attempt(u_bob, format('insert into public.drive_folder (workspace_id, name, created_by) values (%L, %L, %L)', ws, '   ', m_bob)), 'refused:23514');

  -- ── Folders: what a member may change ──
  perform pg_temp.expect('a member renames a folder',
    pg_temp.attempt(u_bob, format('update public.drive_folder set name = %L where id = %L', 'Customers', f_top)), 'rows=1');
  perform pg_temp.expect('a member moves a folder into another',
    pg_temp.attempt(u_bob, format('update public.drive_folder set parent_id = %L where id = %L', f_bob, f_top)), 'rows=1');
  perform pg_temp.expect('a folder never sits inside itself',
    pg_temp.attempt(u_bob, format('update public.drive_folder set parent_id = id where id = %L', f_top)), 'refused:23514');
  perform pg_temp.expect('a folder never sits inside its own subfolder',
    pg_temp.attempt(u_bob, format('update public.drive_folder set parent_id = %L where id = %L', f_sub, f_top)), 'refused:23514');
  perform pg_temp.expect('a folder keeps its maker',
    pg_temp.attempt(u_bob, format('update public.drive_folder set created_by = %L where id = %L', m_bob, f_top)), 'refused:42501');
  perform pg_temp.expect('a folder keeps its workspace (the guard puts it back)',
    pg_temp.read_as(u_alice, format($q$with u as (update public.drive_folder set workspace_id = %L where id = %L returning workspace_id) select workspace_id::text from u$q$, ws2, f_top)), ws::text);
  perform pg_temp.expect('a guest renames none',
    pg_temp.attempt(u_gwen, format('update public.drive_folder set name = %L where id = %L', 'x', f_top)), 'rows=0');
  perform pg_temp.expect('another workspace''s owner renames none',
    pg_temp.attempt(u_eve, format('update public.drive_folder set name = %L where id = %L', 'x', f_top)), 'rows=0');

  -- ── Folders: who deletes them ──
  perform pg_temp.expect('a member deletes no one else''s folder',
    pg_temp.attempt(u_bob, format('delete from public.drive_folder where id = %L', f_top)), 'rows=0');
  perform pg_temp.expect('its maker deletes it',
    pg_temp.attempt(u_alice, format('delete from public.drive_folder where id = %L', f_top)), 'rows=1');
  perform pg_temp.expect('an admin deletes it',
    pg_temp.attempt(u_dana, format('delete from public.drive_folder where id = %L', f_bob)), 'rows=1');

  -- ── Filing records ──
  perform pg_temp.expect('a member files a doc they can open',
    pg_temp.attempt(u_bob, format('insert into public.drive_folder_item (item_type, item_id, folder_id, workspace_id) values (%L, %L, %L, %L)', 'document', d_shared, f_top, ws)), 'rows=1');
  perform pg_temp.expect('a member files a spreadsheet they can open',
    pg_temp.attempt(u_bob, format('insert into public.drive_folder_item (item_type, item_id, folder_id, workspace_id) values (%L, %L, %L, %L)', 'spreadsheet', s_shared, f_top, ws)), 'rows=1');
  perform pg_temp.expect('nobody files a private doc they cannot open',
    pg_temp.attempt(u_bob, format('insert into public.drive_folder_item (item_type, item_id, folder_id, workspace_id) values (%L, %L, %L, %L)', 'document', d_private, f_top, ws)), 'refused:42501');
  perform pg_temp.expect('nobody files another workspace''s doc',
    pg_temp.attempt(u_bob, format('insert into public.drive_folder_item (item_type, item_id, folder_id, workspace_id) values (%L, %L, %L, %L)', 'document', d_other, f_top, ws)), 'refused:42501');
  perform pg_temp.expect('nobody files into another workspace''s folder',
    pg_temp.attempt(u_bob, format('insert into public.drive_folder_item (item_type, item_id, folder_id, workspace_id) values (%L, %L, %L, %L)', 'document', d_shared, f_other, ws)), 'refused:42501');
  perform pg_temp.expect('a guest files nothing',
    pg_temp.attempt(u_gwen, format('insert into public.drive_folder_item (item_type, item_id, folder_id, workspace_id) values (%L, %L, %L, %L)', 'document', d_shared, f_top, ws)), 'refused:42501');
  perform pg_temp.expect('a kind that is not a Drive record is refused',
    pg_temp.attempt(u_bob, format('insert into public.drive_folder_item (item_type, item_id, folder_id, workspace_id) values (%L, %L, %L, %L)', 'contact', d_shared, f_top, ws)), 'refused:42501');
  perform pg_temp.expect('and the check refuses it even for the service role',
    pg_temp.attempt(null, format('insert into public.drive_folder_item (item_type, item_id, folder_id, workspace_id) values (%L, %L, %L, %L)', 'contact', d_shared, f_top, ws)), 'refused:23514');
  perform pg_temp.expect('it is filed as the one who filed it, whatever was sent',
    pg_temp.read_as(u_bob, format($q$with i as (insert into public.drive_folder_item (item_type, item_id, folder_id, workspace_id, added_by) values (%L, %L, %L, %L, %L) returning added_by) select added_by::text from i$q$, 'document', d_shared, f_top, ws, m_alice)), m_bob::text);
  perform pg_temp.expect('its workspace is its folder''s, whatever was sent',
    pg_temp.read_as(u_alice, format($q$with i as (insert into public.drive_folder_item (item_type, item_id, folder_id, workspace_id) values (%L, %L, %L, %L) returning workspace_id) select workspace_id::text from i$q$, 'document', d_private, f_top, ws2)), ws::text);

  -- A private doc its maker filed.
  insert into public.drive_folder_item (item_type, item_id, folder_id, workspace_id) values ('document', d_private, f_sub, ws);
  insert into public.drive_folder_item (item_type, item_id, folder_id, workspace_id) values ('document', d_shared, f_top, ws);

  perform pg_temp.expect('one folder a record at most',
    pg_temp.attempt(u_bob, format('insert into public.drive_folder_item (item_type, item_id, folder_id, workspace_id) values (%L, %L, %L, %L)', 'document', d_shared, f_bob, ws)), 'refused:23505');
  perform pg_temp.expect('a member moves a filed record to another folder',
    pg_temp.attempt(u_bob, format('update public.drive_folder_item set folder_id = %L where item_type = %L and item_id = %L', f_bob, 'document', d_shared)), 'rows=1');
  perform pg_temp.expect('a filed row never becomes another record',
    pg_temp.attempt(u_bob, format('update public.drive_folder_item set item_id = %L where item_type = %L and item_id = %L', s_shared, 'document', d_shared)), 'refused:42501');
  perform pg_temp.expect('nobody moves a record into another workspace''s folder',
    pg_temp.attempt(u_bob, format('update public.drive_folder_item set folder_id = %L where item_type = %L and item_id = %L', f_other, 'document', d_shared)), 'refused:42501');
  perform pg_temp.expect('a guest sees no filed rows',
    pg_temp.read_as(u_gwen, format('select count(*)::text from public.drive_folder_item where workspace_id = %L', ws)), '0');
  perform pg_temp.expect('another workspace''s owner sees no filed rows',
    pg_temp.read_as(u_eve, format('select count(*)::text from public.drive_folder_item where workspace_id = %L', ws)), '0');
  perform pg_temp.expect('a member unfiles a record',
    pg_temp.attempt(u_bob, format('delete from public.drive_folder_item where item_type = %L and item_id = %L', 'document', d_shared)), 'rows=1');

  -- A folder's contents, read the way the app reads them (the records under
  -- the reader's own row security): Bob sees nothing of Alice's private doc.
  perform pg_temp.expect('a private doc in a folder shows to its maker',
    pg_temp.read_as(u_alice, format('select count(*)::text from public.drive_folder_item i join public.document d on d.id = i.item_id where i.folder_id = %L', f_sub)), '1');
  perform pg_temp.expect('and to no one else',
    pg_temp.read_as(u_bob, format('select count(*)::text from public.drive_folder_item i join public.document d on d.id = i.item_id where i.folder_id = %L', f_sub)), '0');

  -- Deleting a folder deletes its subfolders and unfiles what was in them;
  -- the records themselves stay.
  perform set_config('request.jwt.claims', json_build_object('sub', u_alice, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  delete from public.drive_folder where id = f_top;
  execute 'reset role';
  perform pg_temp.expect('deleting a folder deletes its subfolder',
    (select count(*)::text from public.drive_folder where id in (f_top, f_sub)), '0');
  perform pg_temp.expect('and unfiles what was in it',
    (select count(*)::text from public.drive_folder_item where item_id = d_private), '0');
  perform pg_temp.expect('and deletes no record',
    (select count(*)::text from public.document where id = d_private), '1');

  -- The service role is not held to the guards (the agents' tools check first).
  perform pg_temp.expect('the service role files any record',
    pg_temp.attempt(null, format('insert into public.drive_folder_item (item_type, item_id, folder_id, workspace_id) values (%L, %L, %L, %L)', 'document', d_private, f_bob, ws)), 'rows=1');
end
$probe$;

select '690 drive_folders: all checks passed' as result;

rollback;
