-- DB-level test for migration 699 (snippets): who reads, makes, changes and
-- deletes a snippet, what the guard holds a client to, the two unique
-- shortcuts, and what happens when a member leaves (their personal snippets
-- go, their shared ones stay for the workspace's owners and admins, and the
-- removal itself never fails).
--
-- Run against a database with the migrations applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/699_snippets.sql
-- Prints "699 snippets: all checks passed". Everything runs in one transaction
-- that is rolled back, and every attempt below runs in its own subtransaction
-- that is rolled back too. Made-up people only (example.test). A failed check
-- raises and aborts.
--
-- People: Alice and Bob are members, Carol an admin, all of one workspace;
-- Xavier owns another workspace.

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
    raise exception using errcode = 'P0699', message = 'rows=' || n;
  exception when others then
    if sqlstate = 'P0699' then
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

create or replace function pg_temp.add_sql(p_ws uuid, p_by uuid, p_shortcut text, p_visibility text) returns text language sql as $f$
  select format(
    'insert into public.snippet (workspace_id, created_by, name, shortcut, body, visibility) values (%L, %L, %L, %L, %L, %L)',
    p_ws, p_by, 'Snippet ' || p_shortcut, p_shortcut, 'Words of ' || p_shortcut, p_visibility)
$f$;

do $probe$
declare
  u_alice  constant uuid := '00000000-0000-4000-8000-000000699001';
  u_bob    constant uuid := '00000000-0000-4000-8000-000000699002';
  u_carol  constant uuid := '00000000-0000-4000-8000-000000699003';
  u_xavier constant uuid := '00000000-0000-4000-8000-000000699004';
  ws uuid; ws_x uuid;
  m_alice uuid; m_bob uuid; m_carol uuid; m_xavier uuid;
  s_alice uuid; s_shared uuid; s_bob uuid; s_intro uuid;
begin
  insert into auth.users (id, email) values
    (u_alice, 'alice@t699.example.test'), (u_bob, 'bob@t699.example.test'),
    (u_carol, 'carol@t699.example.test'), (u_xavier, 'xavier@t699.example.test');
  insert into public.workspace (name, slug) values ('t699 team', 't699-team-699') returning id into ws;
  insert into public.workspace (name, slug) values ('t699 other', 't699-other-699') returning id into ws_x;
  insert into public.member (user_id, workspace_id, role, display_name) values (u_alice, ws, 'member', 'Alice T699') returning id into m_alice;
  insert into public.member (user_id, workspace_id, role, display_name) values (u_bob, ws, 'member', 'Bob T699') returning id into m_bob;
  insert into public.member (user_id, workspace_id, role, display_name) values (u_carol, ws, 'admin', 'Carol T699') returning id into m_carol;
  insert into public.member (user_id, workspace_id, role, display_name) values (u_xavier, ws_x, 'owner', 'Xavier T699') returning id into m_xavier;

  -- ── Making ──
  perform pg_temp.expect('Alice makes a personal snippet', pg_temp.attempt(u_alice, pg_temp.add_sql(ws, m_alice, 'sig', 'personal')), 'rows=1');
  perform pg_temp.expect('Bob cannot make one as Alice', pg_temp.attempt(u_bob, pg_temp.add_sql(ws, m_alice, 'fake', 'personal')), 'refused:42501');
  perform pg_temp.expect('Xavier cannot make one in another workspace', pg_temp.attempt(u_xavier, pg_temp.add_sql(ws, m_xavier, 'x', 'personal')), 'refused:42501');
  perform pg_temp.expect('A shortcut is one word', pg_temp.attempt(u_alice, pg_temp.add_sql(ws, m_alice, 'Two Words', 'personal')), 'refused:23514');

  insert into public.snippet (workspace_id, created_by, name, shortcut, body) values (ws, m_alice, 'Sig', 'sig', 'Best, Alice') returning id into s_alice;
  insert into public.snippet (workspace_id, created_by, name, shortcut, body, visibility) values (ws, m_alice, 'Pricing', 'pricing', 'Plans start at…', 'workspace') returning id into s_shared;
  insert into public.snippet (workspace_id, created_by, name, shortcut, body) values (ws, m_bob, 'Sig', 'sig', 'Best, Bob') returning id into s_bob;

  perform pg_temp.expect('Alice cannot have two ;sig', pg_temp.attempt(u_alice, pg_temp.add_sql(ws, m_alice, 'sig', 'personal')), 'refused:23505');
  perform pg_temp.expect('The workspace cannot have two shared ;pricing', pg_temp.attempt(u_bob, pg_temp.add_sql(ws, m_bob, 'pricing', 'workspace')), 'refused:23505');
  perform pg_temp.expect('Bob may share a ;sig while Alice keeps a personal one', pg_temp.attempt(u_bob, pg_temp.add_sql(ws, m_bob, 'sig', 'workspace')), 'rows=1');

  -- ── Reading ──
  perform pg_temp.expect('Alice reads her own and the shared one', pg_temp.attempt(u_alice, format('select 1 from public.snippet where workspace_id = %L', ws)), 'rows=2');
  perform pg_temp.expect('Bob reads his own and the shared one', pg_temp.attempt(u_bob, format('select 1 from public.snippet where workspace_id = %L', ws)), 'rows=2');
  perform pg_temp.expect('Carol, an admin, reads the shared one only', pg_temp.attempt(u_carol, format('select 1 from public.snippet where workspace_id = %L', ws)), 'rows=1');
  perform pg_temp.expect('Xavier reads none of them', pg_temp.attempt(u_xavier, format('select 1 from public.snippet where workspace_id = %L', ws)), 'rows=0');

  -- ── Changing ──
  perform pg_temp.expect('Bob cannot change Alice''s shared one', pg_temp.attempt(u_bob, format('update public.snippet set body = %L where id = %L', 'hijack', s_shared)), 'rows=0');
  perform pg_temp.expect('Carol, an admin, changes the shared one', pg_temp.attempt(u_carol, format('update public.snippet set body = %L where id = %L', 'Admin words', s_shared)), 'rows=1');
  perform pg_temp.expect('Carol cannot make it personal', pg_temp.attempt(u_carol, format('update public.snippet set visibility = %L where id = %L', 'personal', s_shared)), 'refused:42501');
  perform pg_temp.expect('Carol cannot take it over', pg_temp.attempt(u_carol, format('update public.snippet set created_by = %L where id = %L', m_carol, s_shared)), 'refused:42501');
  perform pg_temp.expect('Carol cannot change Bob''s personal one', pg_temp.attempt(u_carol, format('update public.snippet set body = %L where id = %L', 'x', s_bob)), 'rows=0');
  perform pg_temp.expect('Carol cannot delete Bob''s personal one', pg_temp.attempt(u_carol, format('delete from public.snippet where id = %L', s_bob)), 'rows=0');
  perform pg_temp.expect('Alice cannot delete Bob''s personal one', pg_temp.attempt(u_alice, format('delete from public.snippet where id = %L', s_bob)), 'rows=0');
  perform pg_temp.expect('Alice makes her shared one personal', pg_temp.attempt(u_alice, format('update public.snippet set visibility = %L where id = %L', 'personal', s_shared)), 'rows=1');
  insert into public.snippet (workspace_id, created_by, name, shortcut, body, visibility) values (ws, m_bob, 'Team sig', 'sig', 'Best, the team', 'workspace');
  perform pg_temp.expect('Alice cannot share her ;sig while Bob''s shared ;sig stands (the app words it)',
    pg_temp.attempt(u_alice, format('update public.snippet set visibility = %L where id = %L', 'workspace', s_alice)), 'refused:23505');
  perform pg_temp.expect('Alice deletes her own', pg_temp.attempt(u_alice, format('delete from public.snippet where id = %L', s_alice)), 'rows=1');

  -- The guard keeps the workspace whoever writes; the service role is not held to the client rules.
  update public.snippet set workspace_id = ws_x where id = s_alice;
  perform pg_temp.expect('The workspace never changes', (select workspace_id::text from public.snippet where id = s_alice), ws::text);
  perform pg_temp.expect('The service role may set its maker', pg_temp.attempt(null, format('update public.snippet set created_by = %L where id = %L', m_carol, s_bob)), 'rows=1');

  -- ── A member leaves ──
  insert into public.snippet (workspace_id, created_by, name, shortcut, body, visibility) values (ws, m_alice, 'Intro', 'intro', 'Hi', 'workspace') returning id into s_intro;
  delete from public.member where id = m_alice;
  perform pg_temp.expect('Her personal snippet goes with her',
    (select count(*)::text from public.snippet where id = s_alice), '0');
  perform pg_temp.expect('Her other shared one stays too',
    (select coalesce(created_by::text, 'none') || ':' || visibility from public.snippet where id = s_shared), 'none:workspace');
  perform pg_temp.expect('Her shared one stays, with no maker',
    (select coalesce(created_by::text, 'none') || ':' || visibility from public.snippet where id = s_intro), 'none:workspace');
  perform pg_temp.expect('Carol, an admin, changes it', pg_temp.attempt(u_carol, format('update public.snippet set body = %L where id = %L', 'Hello', s_intro)), 'rows=1');
  perform pg_temp.expect('Carol cannot make it personal', pg_temp.attempt(u_carol, format('update public.snippet set visibility = %L where id = %L', 'personal', s_intro)), 'refused:42501');
  perform pg_temp.expect('Bob cannot change it', pg_temp.attempt(u_bob, format('update public.snippet set body = %L where id = %L', 'B', s_intro)), 'rows=0');
  perform pg_temp.expect('Carol deletes it', pg_temp.attempt(u_carol, format('delete from public.snippet where id = %L', s_intro)), 'rows=1');

  -- ── The workspace goes, its snippets with it ──
  delete from public.workspace where id = ws;
  perform pg_temp.expect('No snippet outlives its workspace', (select count(*)::text from public.snippet where workspace_id = ws), '0');

  raise notice '699 snippets: all checks passed';
end $probe$;

rollback;
