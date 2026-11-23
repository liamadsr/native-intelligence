-- DB-level test for migration 704 (work_imports): an import and its journal
-- are read by the person who ran it alone, while they are still a member of
-- its workspace; no client writes either table; the guards hold even for a
-- write a policy would let through; an item's workspace is its import's.
--
-- Run against a database with the migrations applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/704_work_imports.sql
-- Prints "704 work_imports: all checks passed". Everything runs in one
-- transaction that is rolled back, and every attempt below runs in its own
-- subtransaction that is rolled back too. Made-up people only. A failed
-- check raises and aborts.
--
-- People: Alice ran the import; Bob is a member of the same workspace;
-- Carol is a member of another workspace; Dave ran an import and then left.

begin;

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
    raise exception using errcode = 'P0704', message = 'rows=' || n;
  exception when others then
    if sqlstate = 'P0704' then
      return sqlerrm;
    end if;
    return 'refused:' || sqlstate;
  end;
end $f$;

-- Like attempt, but first (as the table's owner) opens p_table to client
-- updates with a grant and an allow-all policy, so only the guard can refuse.
create or replace function pg_temp.attempt_open(p_table text, p_user uuid, p_sql text) returns text language plpgsql as $f$
declare
  n int;
begin
  begin
    execute format('grant update on public.%I to authenticated', p_table);
    execute format('create policy _t on public.%I for update to authenticated using (true) with check (true)', p_table);
    perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    execute p_sql;
    get diagnostics n = row_count;
    raise exception using errcode = 'P0704', message = 'rows=' || n;
  exception when others then
    if sqlstate = 'P0704' then
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

do $$
declare
  alice uuid := '70400000-0000-0000-0000-00000000000a';
  bob   uuid := '70400000-0000-0000-0000-00000000000b';
  carol uuid := '70400000-0000-0000-0000-00000000000c';
  dave  uuid := '70400000-0000-0000-0000-00000000000d';
  ws1   uuid := '70400000-0000-0000-0000-000000000101';
  ws2   uuid := '70400000-0000-0000-0000-000000000102';
  imp   uuid := '70400000-0000-0000-0000-000000000201';
  gone  uuid := '70400000-0000-0000-0000-000000000202';
  item  uuid := '70400000-0000-0000-0000-000000000301';
begin
  insert into auth.users (id) values (alice), (bob), (carol), (dave);
  insert into public.workspace (id) values (ws1), (ws2);
  insert into public.member (workspace_id, user_id, role) values (ws1, alice, 'member'), (ws1, bob, 'admin'), (ws2, carol, 'owner');

  -- The app (service role) writes the journal.
  perform pg_temp.expect('service makes an import', pg_temp.attempt(null, format(
    $q$insert into public.work_import (id, workspace_id, user_id, source, label) values (%L, %L, %L, 'task_csv', 'tasks.csv')$q$, imp, ws1, alice)), 'rows=1');
  insert into public.work_import (id, workspace_id, user_id, source, label) values (imp, ws1, alice, 'task_csv', 'tasks.csv');
  insert into public.work_import (id, workspace_id, user_id, source) values (gone, ws1, dave, 'linear');
  insert into public.work_import_item (id, import_id, workspace_id, seq, ref, kind, record)
    values (item, imp, ws1, 0, 'row:2', 'action', '{"kind":"action","title":"A"}');

  -- Reads: Alice alone.
  perform pg_temp.expect('alice reads her import', pg_temp.attempt(alice, format('select 1 from public.work_import where id = %L', imp)), 'rows=1');
  perform pg_temp.expect('alice reads its items', pg_temp.attempt(alice, format('select 1 from public.work_import_item where import_id = %L', imp)), 'rows=1');
  perform pg_temp.expect('bob, an admin of the workspace, does not', pg_temp.attempt(bob, 'select 1 from public.work_import'), 'rows=0');
  perform pg_temp.expect('bob reads no item', pg_temp.attempt(bob, 'select 1 from public.work_import_item'), 'rows=0');
  perform pg_temp.expect('carol, elsewhere, does not', pg_temp.attempt(carol, 'select 1 from public.work_import'), 'rows=0');
  perform pg_temp.expect('dave, who left, no longer reads his', pg_temp.attempt(dave, 'select 1 from public.work_import'), 'rows=0');
  perform pg_temp.expect('anon reads nothing', pg_temp.attempt(null, 'set local role anon; select 1 from public.work_import'), 'refused:42501');

  -- Writes: no client, not even the importer.
  perform pg_temp.expect('alice cannot make an import', pg_temp.attempt(alice, format(
    $q$insert into public.work_import (workspace_id, user_id, source) values (%L, %L, 'notion')$q$, ws1, alice)), 'refused:42501');
  perform pg_temp.expect('alice cannot change her import', pg_temp.attempt(alice, format(
    $q$update public.work_import set status = 'done' where id = %L$q$, imp)), 'refused:42501');
  perform pg_temp.expect('alice cannot delete it', pg_temp.attempt(alice, format('delete from public.work_import where id = %L', imp)), 'refused:42501');
  perform pg_temp.expect('alice cannot add an item', pg_temp.attempt(alice, format(
    $q$insert into public.work_import_item (import_id, workspace_id, seq, ref, kind, record) values (%L, %L, 1, 'x', 'label', '{}')$q$, imp, ws1)), 'refused:42501');
  perform pg_temp.expect('alice cannot rewrite an item', pg_temp.attempt(alice, format(
    $q$update public.work_import_item set outcome = 'created' where id = %L$q$, item)), 'refused:42501');

  -- The guards hold even with a write policy in place (the second fence).
  perform pg_temp.expect('guard: a client update of whose import it is', pg_temp.attempt_open('work_import', alice, format($q$update public.work_import set user_id = %L where id = %L$q$, bob, imp)), 'refused:42501');
  perform pg_temp.expect('guard: a client update of a planned record', pg_temp.attempt_open('work_import_item', alice, format($q$update public.work_import_item set record = '{"kind":"action","title":"B"}' where id = %L$q$, item)), 'refused:42501');
  perform pg_temp.expect('guard: a client update of an outcome passes the guard', pg_temp.attempt_open('work_import_item', alice, format($q$update public.work_import_item set outcome = 'created' where id = %L$q$, item)), 'rows=1');

  -- An item belongs to its import's workspace, even from the service role.
  perform pg_temp.expect('an item in another workspace', pg_temp.attempt(null, format(
    $q$insert into public.work_import_item (import_id, workspace_id, seq, ref, kind, record) values (%L, %L, 1, 'x', 'label', '{}')$q$, imp, ws2)), 'refused:23514');
  perform pg_temp.expect('a repeated ref', pg_temp.attempt(null, format(
    $q$insert into public.work_import_item (import_id, workspace_id, seq, ref, kind, record) values (%L, %L, 1, 'row:2', 'label', '{}')$q$, imp, ws1)), 'refused:23505');
  perform pg_temp.expect('an unknown kind', pg_temp.attempt(null, format(
    $q$insert into public.work_import_item (import_id, workspace_id, seq, ref, kind, record) values (%L, %L, 1, 'y', 'contact', '{}')$q$, imp, ws1)), 'refused:23514');
  perform pg_temp.expect('an unknown status', pg_temp.attempt(null, format(
    $q$update public.work_import set status = 'paused' where id = %L$q$, imp)), 'refused:23514');
  perform pg_temp.expect('the service role moves an import on', pg_temp.attempt(null, format(
    $q$update public.work_import set status = 'running' where id = %L$q$, imp)), 'rows=1');

  raise notice '704 work_imports: all checks passed';
end $$;

rollback;
